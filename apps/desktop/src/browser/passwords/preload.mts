// 用户标签的自动填充预加载（打成 dist/autofill-preload.cjs，只挂在 kind === 'user' 的标签上，各个框架都跑一份）。
// 跑在隔离环境里，不往网页暴露任何东西：不用 contextBridge、不加全局变量、不改 DOM，只听事件。
//
// 流程：登录框获得焦点时问主进程这个框架有没有候选（主进程按 senderFrame 的真实源回答，只回用户名，
// 这里的消息不带源）；用户真的点了这个框（或在框里按 ↓）才请主进程弹候选菜单。菜单是主进程的原生菜单，
// 网页看不到也点不到；用户点选了一条，主进程才把那一条的用户名和密码送到这个框架，这里填进去。
// 网页自己造的事件（isTrusted 为假）一律不理，网页弹不出菜单。
import { ipcRenderer } from 'electron'
import { fillInput, type LoginFields, loginFieldsOf, usable } from './form.mjs'
import { AUTOFILL_FILL, AUTOFILL_OFFER, AUTOFILL_QUERY } from './ipc.mjs'

/** 获得焦点前多久以内的一次真实按下算“用户点了这个框” */
const POINTER_WINDOW_MS = 1000

/** 最近一次真实按下的元素和时间 */
let pressed: { target: EventTarget | null; at: number } = { target: null, at: 0 }
/** 有候选的那个登录框（焦点在它上面时） */
let active: { field: HTMLInputElement; fields: LoginFields } | null = null
/** 最近一次请主进程弹菜单的那个登录表单：填的时候填它 */
let offered: LoginFields | null = null

const targetOf = (event: Event): EventTarget | null => event.composedPath()[0] ?? event.target

const rectOf = (field: HTMLInputElement) => {
  const rect = field.getBoundingClientRect()
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
}

const offer = (field: HTMLInputElement, fields: LoginFields) => {
  offered = fields
  ipcRenderer.send(AUTOFILL_OFFER, { rect: rectOf(field) })
}

window.addEventListener(
  'pointerdown',
  (event) => {
    if (!event.isTrusted) return
    const target = targetOf(event)
    pressed = { target, at: Date.now() }
    // 已经有焦点的框再点一下：再弹一次
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
    if (!event.isTrusted || !active || event.key !== 'ArrowDown') return
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (targetOf(event) !== active.field) return
    offer(active.field, active.fields)
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
