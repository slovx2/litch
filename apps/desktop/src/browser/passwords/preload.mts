// 标签里的自动填充预加载（打成 dist/autofill-preload.cjs，用户的、代理的标签都挂，各个框架都跑一份）。
// 跑在隔离环境里，不往网页暴露任何东西：不用 contextBridge、不加全局变量，只听事件；往网页 DOM 里加的只有
// 代理标签里画候选的那个宿主元素（网页看得出它在不在、多大，读不到里面的用户名，见 showOverlay）。
//
// 自动填充：登录框获得焦点时问主进程这个框架有没有候选（主进程按 senderFrame 的真实源回答，只回用户名，
// 这里的消息不带源）；有人真的点了这个框（或在框里按 ↓）才请主进程给候选。用户的标签由主进程弹原生菜单；
// 代理的标签主进程把用户名交回来，这里画在网页里一个封闭的影子树里（网页脚本读不到用户名，代理在快照里看得到），
// 受信任的点击点中一条才报回“第几条”。点选之后主进程才把那一条的用户名和密码送到这个框架，这里填进去。
// 网页自己造的事件（isTrusted 为假）一律不理：网页弹不出候选、也点不中。
//
// 保存提示：登录表单提交（受信任地点了表单里的按钮、在登录框里按了回车，或紧跟着这两种的 submit）时，
// 把用户名和密码交给主进程；只有用户名的表单（两步登录的第一步）只交用户名。
// 要不要提示、提示给谁由主进程定（导航完成后只推给 Litch 的界面）。
import { ipcRenderer } from 'electron'
import {
  fillInput,
  type LoginFields,
  loginFieldsOf,
  stepUsername,
  submissionOf,
  usable,
} from './form.mjs'
import {
  AUTOFILL_CAPTURE,
  AUTOFILL_FILL,
  AUTOFILL_OFFER,
  AUTOFILL_PICK,
  AUTOFILL_QUERY,
} from './ipc.mjs'

/** 获得焦点前多久以内的一次真实按下算“有人点了这个框” */
const POINTER_WINDOW_MS = 1000

/** 最近一次真实按下的元素和时间 */
let pressed: { target: EventTarget | null; at: number } = { target: null, at: 0 }
/** 最近一次真实的按下或回车：submit 只认紧跟着它、发生在那个表单里的 */
let gesture: { target: EventTarget | null; at: number } = { target: null, at: 0 }
/** submit 前多久以内的一次真实按下或回车算“是人（或代理）提交的” */
const GESTURE_WINDOW_MS = 1500
/** 有候选的那个登录框（焦点在它上面时） */
let active: { field: HTMLInputElement; fields: LoginFields } | null = null
/** 最近一次请主进程给候选的那个登录表单：填的时候填它 */
let offered: LoginFields | null = null
/** 网页里画出来的候选（代理的标签） */
let overlay: { host: HTMLElement; field: HTMLInputElement } | null = null

const targetOf = (event: Event): EventTarget | null => event.composedPath()[0] ?? event.target

const rectOf = (field: HTMLInputElement) => {
  const rect = field.getBoundingClientRect()
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
}

const zh = () => (navigator.language || '').toLowerCase().startsWith('zh')

const closeOverlay = () => {
  overlay?.host.remove()
  overlay = null
}

/**
 * 代理的标签：把候选画在框下面。只有用户名；按钮被受信任地点中才报回第几条。
 * 宿主元素是网页 DOM 里的真实元素，网页看得出它在不在、在哪、多大（也就知道这个站存了密码、大概几条），
 * 但读不到里面：影子树是封闭的；字不放进文本节点，用户名只在按钮的 aria-label（代理的无障碍快照看得到）和
 * ::before 的生成内容（人看得到）里，网页的 window.find、全选之后的 getSelection、innerText 都碰不到；
 * 宽度固定，看不出用户名多长
 */
function showOverlay(field: HTMLInputElement, usernames: string[]) {
  closeOverlay()
  const rect = field.getBoundingClientRect()
  const host = document.createElement('litch-autofill')
  host.setAttribute(
    'style',
    `all: initial !important; display: block !important; position: fixed !important; z-index: 2147483647 !important; left: ${Math.round(rect.left)}px !important; top: ${Math.round(rect.bottom + 2)}px !important;`,
  )
  const root = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = `
    .box { font: 13px/1.4 system-ui, sans-serif; background: #fff; color: #111; border: 1px solid #888;
      border-radius: 6px; box-shadow: 0 4px 14px rgba(0,0,0,.2); padding: 4px; width: 240px;
      box-sizing: border-box; user-select: none; -webkit-user-select: none; }
    .title { color: #555; font-size: 11px; padding: 2px 8px 4px; }
    .title::before, button::before { content: attr(data-label); }
    button { all: unset; display: block; box-sizing: border-box; width: 100%; padding: 5px 8px;
      border-radius: 4px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    button:hover, button:focus { background: #e6eefc; }`
  const box = document.createElement('div')
  box.className = 'box'
  box.setAttribute('role', 'group')
  const title = zh() ? 'Litch 已保存的密码' : 'Litch saved passwords'
  box.setAttribute('aria-label', title)
  const head = document.createElement('div')
  head.className = 'title'
  head.setAttribute('aria-hidden', 'true')
  head.dataset.label = title
  box.append(head)
  usernames.forEach((username, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    const label = username === '' ? (zh() ? '（没有用户名）' : '(no username)') : username
    button.setAttribute('aria-label', label)
    button.dataset.label = label
    button.addEventListener('click', (event) => {
      if (!event.isTrusted) return
      closeOverlay()
      ipcRenderer.send(AUTOFILL_PICK, { index })
    })
    box.append(button)
  })
  root.append(style, box)
  document.documentElement.append(host)
  overlay = { host, field }
}

const offer = (field: HTMLInputElement, fields: LoginFields) => {
  offered = fields
  void ipcRenderer.invoke(AUTOFILL_OFFER, { rect: rectOf(field) }).then(
    (reply: unknown) => {
      const usernames = (reply as { usernames?: unknown } | null)?.usernames
      if (!Array.isArray(usernames) || usernames.length === 0 || !field.isConnected) return
      showOverlay(
        field,
        usernames.filter((one): one is string => typeof one === 'string'),
      )
    },
    () => {},
  )
}

/** 一次登录提交：表单里（没有表单就是整个文档）交上去的用户名和密码；只有用户名的当两步登录的第一步 */
function capture(scope: ParentNode | null) {
  const root = scope ?? document
  const submitted = submissionOf(root)
  if (submitted) {
    ipcRenderer.send(AUTOFILL_CAPTURE, submitted)
    return
  }
  const username = stepUsername(root)
  if (username !== '') ipcRenderer.send(AUTOFILL_CAPTURE, { username, step: true })
}

window.addEventListener(
  'pointerdown',
  (event) => {
    if (!event.isTrusted) return
    const target = targetOf(event)
    pressed = { target, at: Date.now() }
    gesture = pressed
    if (overlay && target !== overlay.host && target !== overlay.field) closeOverlay()
    // 已经有焦点的框再点一下：再给一次
    if (active && target === active.field) offer(active.field, active.fields)
  },
  true,
)

window.addEventListener(
  'focusin',
  (event) => {
    if (!event.isTrusted) return
    const target = targetOf(event)
    const fields = loginFieldsOf(target)
    if (!fields || !(target instanceof HTMLInputElement)) {
      active = null
      return
    }
    const byPointer = pressed.target === target && Date.now() - pressed.at < POINTER_WINDOW_MS
    void ipcRenderer.invoke(AUTOFILL_QUERY).then(
      (reply: unknown) => {
        const usernames = (reply as { usernames?: unknown } | null)?.usernames
        if (!Array.isArray(usernames) || usernames.length === 0) return
        // 应答回来之前焦点已经走了
        if (!target.matches(':focus')) return
        active = { field: target, fields }
        if (byPointer) offer(target, fields)
      },
      () => {},
    )
  },
  true,
)

window.addEventListener(
  'focusout',
  (event) => {
    if (active && targetOf(event) === active.field) active = null
  },
  true,
)

window.addEventListener(
  'keydown',
  (event) => {
    if (!event.isTrusted) return
    if (event.key === 'Escape') closeOverlay()
    const target = targetOf(event)
    if (event.key === 'Enter') gesture = { target, at: Date.now() }
    // 在登录框里按回车：多半是提交
    if (event.key === 'Enter' && target instanceof HTMLInputElement && loginFieldsOf(target)) {
      capture(target.form)
    }
    if (!active || event.key !== 'ArrowDown') return
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (target !== active.field) return
    offer(active.field, active.fields)
  },
  true,
)

// 点了按钮：在表单里的看这个表单；不在表单里的（单页应用的登录）看整个文档
window.addEventListener(
  'click',
  (event) => {
    if (!event.isTrusted) return
    const target = targetOf(event)
    if (!(target instanceof Element) || target.tagName === 'LITCH-AUTOFILL') return
    const button = target.closest(
      'button, input[type="submit"], input[type="image"], [role="button"]',
    )
    if (!button) return
    capture(button instanceof HTMLButtonElement ? button.form : button.closest('form'))
  },
  true,
)

// 表单提交：网页自己 dispatchEvent 的（isTrusted 为假）、脚本 requestSubmit() 的（isTrusted 为真，但前面没有
// 人在这个表单里按下或回车）都不算
window.addEventListener(
  'submit',
  (event) => {
    if (!event.isTrusted || !(event.target instanceof HTMLFormElement)) return
    const by = gesture.target
    if (Date.now() - gesture.at > GESTURE_WINDOW_MS || !(by instanceof Node)) return
    if (!event.target.contains(by)) return
    capture(event.target)
  },
  true,
)

ipcRenderer.on(AUTOFILL_FILL, (_event, message: unknown) => {
  const fields = offered
  offered = null
  if (!fields || !message || typeof message !== 'object') return
  const { username, password } = message as { username?: unknown; password?: unknown }
  if (typeof username !== 'string' || typeof password !== 'string') return
  if (fields.username && usable(fields.username)) fillInput(fields.username, username)
  if (fields.password && usable(fields.password)) fillInput(fields.password, password)
})
