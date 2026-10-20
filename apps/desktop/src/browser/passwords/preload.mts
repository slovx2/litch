// 标签里的自动填充预加载（打成 dist/autofill-preload.cjs，用户的、代理的标签都挂，各个框架都跑一份）。
// 跑在隔离环境里，不往网页暴露任何东西：不用 contextBridge、不加全局变量、不往网页 DOM 里加东西，只听事件。
//
// 自动填充：登录框获得焦点时问主进程这个框架有没有候选（主进程按 senderFrame 的真实源回答，只回用户名，
// 这里的消息不带源；代理自己在用的标签没有候选）；有人真的点了这个框（或在框里按 ↓）才请主进程给候选，
// 主进程弹原生菜单。点选之后主进程才把那一条的用户名和密码送到这个框架，这里填进去。
// 网页自己造的事件（isTrusted 为假）一律不理：网页弹不出候选。
//
// 保存提示：登录表单提交（受信任地点了表单里的按钮、在登录框里按了回车，或紧跟着这两种的 submit）时，
// 把用户名和密码交给主进程；只有用户名的表单（两步登录的第一步）只交用户名。
// 要不要提示、提示给谁由主进程定（导航完成后只推给 Litch 的界面）。
//
// 交还代理：代理交给人登录的标签（request_sign_in）交还之前，主进程请每个框架清空密码框，清完回一声。
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
  AUTOFILL_CLEAR,
  AUTOFILL_CLEARED,
  AUTOFILL_FILL,
  AUTOFILL_OFFER,
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

const targetOf = (event: Event): EventTarget | null => event.composedPath()[0] ?? event.target

const rectOf = (field: HTMLInputElement) => {
  const rect = field.getBoundingClientRect()
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
}

const offer = (field: HTMLInputElement, fields: LoginFields) => {
  offered = fields
  void ipcRenderer.invoke(AUTOFILL_OFFER, { rect: rectOf(field) }).catch(() => {})
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
    if (!(target instanceof Element)) return
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

// 交还代理之前：清空这个框架里所有密码框（连同开放的影子树里的），清完回一声
ipcRenderer.on(AUTOFILL_CLEAR, (_event, message: unknown) => {
  const token = (message as { token?: unknown } | null)?.token
  const clear = (root: Document | ShadowRoot) => {
    for (const input of Array.from(root.querySelectorAll('input'))) {
      if (input.type === 'password' && input.value !== '') fillInput(input, '')
    }
    for (const element of Array.from(root.querySelectorAll('*'))) {
      if (element.shadowRoot) clear(element.shadowRoot)
    }
  }
  try {
    clear(document)
  } finally {
    ipcRenderer.send(AUTOFILL_CLEARED, { token })
  }
})
