// 自动填充在主进程里的接线：收用户标签预加载的消息，按 senderFrame 的真实源找候选，弹原生菜单，
// 用户点选了才把那一条送进发起的框架。判断都在 broker.mts，这里只把 Electron 的东西包成它要的样子。
//
// 候选为什么用原生菜单：菜单是主进程画的，不在网页的 DOM 里，网页脚本既读不到候选的用户名、也点不到它
// （网页只能在自己的 webContents 里造事件）。用户点选之前密码不离开主进程，点选之后只送进那一个框架的
// 隔离环境，由预加载填进框里。菜单顶上写明是 Litch 的，免得和网页自己画的东西混淆。
import {
  app,
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  type WebContents,
  WebContentsView,
} from 'electron'
import { type AutofillBroker, createAutofillBroker, type FrameRef } from './broker.mjs'
import { AUTOFILL_FILL, AUTOFILL_OFFER, AUTOFILL_QUERY } from './ipc.mjs'
import type { PasswordStore } from './store.mjs'
import { isAutofillTab } from './tabs.mjs'

/** 菜单里一条用户名最长显示这么多字 */
const LABEL_MAX = 80

const WORDS = {
  'zh-CN': { title: 'Litch 已保存的密码', empty: '（没有用户名）' },
  en: { title: 'Litch saved passwords', empty: '(no username)' },
}

const words = () => WORDS[app.getLocale().startsWith('zh') ? 'zh-CN' : 'en']

function frameRefOf(event: IpcMainEvent | IpcMainInvokeEvent): FrameRef | null {
  const frame = event.senderFrame
  if (!frame) return null
  const alive = () => {
    try {
      return !frame.isDestroyed() && !frame.detached
    } catch {
      return false
    }
  }
  return {
    contentsId: event.sender.id,
    origin: () => (alive() ? frame.origin : ''),
    alive,
    send: (message) => {
      if (alive()) frame.send(AUTOFILL_FILL, message)
    },
  }
}

/** 这个 webContents 现在挂在哪个窗口上、视图的位置 */
function placeOf(contents: WebContents) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    const view = window.contentView.children.find(
      (one) => one instanceof WebContentsView && one.webContents === contents,
    )
    if (view) return { window, bounds: view.getBounds() }
  }
  return null
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** 主框架里的框：菜单出在框的左下角；子框架里的算不出在窗口里的位置，出在鼠标那里 */
function anchorOf(
  event: IpcMainEvent,
  bounds: { x: number; y: number; width: number; height: number },
  payload: unknown,
): { x: number; y: number } | null {
  if (event.senderFrame?.parent) return null
  const rect = (payload as { rect?: Record<string, unknown> } | null)?.rect
  if (!rect || !finite(rect.x) || !finite(rect.y) || !finite(rect.height)) return null
  const zoom = event.sender.getZoomFactor()
  const clamp = (value: number, low: number, high: number) =>
    Math.round(Math.min(Math.max(value, low), high))
  return {
    x: clamp(bounds.x + rect.x * zoom, bounds.x, bounds.x + bounds.width),
    y: clamp(bounds.y + (rect.y + rect.height) * zoom, bounds.y, bounds.y + bounds.height),
  }
}

export function installAutofill(store: PasswordStore): AutofillBroker {
  const broker = createAutofillBroker({ store, isUserTab: isAutofillTab })
  /** 菜单开着的标签：开着时再来的请求不理 */
  const open = new Set<number>()

  ipcMain.handle(AUTOFILL_QUERY, (event) => {
    const frame = frameRefOf(event)
    const offer = frame ? broker.offerFor(frame) : null
    return { usernames: offer?.usernames ?? [] }
  })

  ipcMain.on(AUTOFILL_OFFER, (event, payload: unknown) => {
    const contents = event.sender
    if (open.has(contents.id)) return
    const frame = frameRefOf(event)
    const offer = frame ? broker.offerFor(frame) : null
    if (!frame || !offer) return
    const place = placeOf(contents)
    if (!place) return
    const said = words()
    const items: MenuItemConstructorOptions[] = [
      { label: said.title, enabled: false },
      { type: 'separator' },
      ...offer.usernames.map((username, index) => ({
        label:
          username === ''
            ? said.empty
            : username.length > LABEL_MAX
              ? `${username.slice(0, LABEL_MAX)}…`
              : username,
        click: () => {
          broker.fill(frame, offer, index)
        },
      })),
    ]
    const anchor = anchorOf(event, place.bounds, payload)
    open.add(contents.id)
    Menu.buildFromTemplate(items).popup({
      window: place.window,
      ...(anchor ?? {}),
      callback: () => open.delete(contents.id),
    })
  })
  return broker
}
