// 自动填充和保存提示在主进程里的接线：收预加载的消息，按 senderFrame 的真实源找候选、给候选，点选了才把那一条
// 送进发起的框架；收登录提交，交给保存提示（prompts.mts）。判断都在 broker.mts 和 prompts.mts，
// 这里只把 Electron 的东西包成它们要的样子。
//
// 候选怎么给：
// - 用户的标签：主进程的原生菜单。菜单不在网页的 DOM 里，网页脚本既读不到候选的用户名、也点不到它；
//   菜单顶上写明是 Litch 的，免得和网页自己画的东西混淆。
// - 代理的标签：代理看不到原生菜单，所以把用户名交给预加载，画在网页里一个封闭的影子树里（网页看得出那个元素
//   在不在、多大，读不到里面的用户名，见 preload.mts 的 showOverlay），
//   代理在快照里看得到、用 click 点中一条；预加载只认受信任的点击（网页自己造的点击不算），报回“第几条”，
//   主进程只认它先前给这个框架的那一份。
// 两种都一样：点选之前密码不离开主进程，点选之后只送进那一个框架的隔离环境，由预加载填进框里。
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
  webFrameMain,
} from 'electron'
import { type AutofillBroker, createAutofillBroker, type FrameRef } from './broker.mjs'
import {
  AUTOFILL_CAPTURE,
  AUTOFILL_FILL,
  AUTOFILL_OFFER,
  AUTOFILL_PICK,
  AUTOFILL_QUERY,
} from './ipc.mjs'
import { fillableOrigin } from './origin.mjs'
import type { SavePrompts } from './prompts.mjs'
import type { PasswordStore } from './store.mjs'
import { autofillTab } from './tabs.mjs'

/** 菜单里一条用户名最长显示这么多字 */
const LABEL_MAX = 80

const WORDS = {
  'zh-CN': { title: 'Litch 已保存的密码', empty: '（没有用户名）' },
  en: { title: 'Litch saved passwords', empty: '(no username)' },
}

const words = () => WORDS[app.getLocale().startsWith('zh') ? 'zh-CN' : 'en']

/** 网页里画出候选时给代理的那句提示（下一次工具结果里带上） */
const AGENT_NOTICE =
  'Litch listed saved sign-ins under the focused field ("Litch saved passwords"). Take a snapshot and click a username there to fill the form; the password itself is never shown to you.'

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
    key: `${event.sender.id}:${frame.processId}:${frame.routingId}`,
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
  event: IpcMainInvokeEvent,
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

/** 用户的标签：弹原生菜单 */
function popMenu(
  broker: AutofillBroker,
  event: IpcMainInvokeEvent,
  frame: FrameRef,
  payload: unknown,
  open: Set<number>,
) {
  const contents = event.sender
  if (open.has(contents.id)) return
  const offer = broker.offerFor(frame)
  const place = offer ? placeOf(contents) : null
  if (!offer || !place) return
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
}

export function installAutofill(store: PasswordStore, prompts: SavePrompts): AutofillBroker {
  const broker = createAutofillBroker({
    store,
    kindOf: (contentsId) => autofillTab(contentsId)?.kind ?? null,
  })
  /** 菜单开着的标签：开着时再来的请求不理 */
  const open = new Set<number>()
  /** 已经接上导航事件的标签 */
  const watched = new Set<number>()
  /** 网页里画过候选的代理标签（销毁时丢掉它的候选） */
  const inlineTabs = new Set<number>()

  /** 保存提示要等提交的那个框架（或整个标签）导航完成：第一次有它的登录提交时接上它的导航事件 */
  const watch = (contents: WebContents) => {
    const id = contents.id
    if (watched.has(id)) return
    watched.add(id)
    const nodeOf = (isMainFrame: boolean, processId: number, routingId: number) =>
      isMainFrame ? null : (webFrameMain.fromId(processId, routingId)?.frameTreeNodeId ?? -1)
    contents.on('did-frame-navigate', (_event, _url, _code, _status, isMainFrame, pid, rid) =>
      prompts.navigated(id, { frame: nodeOf(isMainFrame, pid, rid), inPage: false }),
    )
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame, pid, rid) =>
      prompts.navigated(id, { frame: nodeOf(isMainFrame, pid, rid), inPage: true }),
    )
    contents.on('did-stop-loading', () => prompts.loaded(id))
    contents.once('destroyed', () => {
      watched.delete(id)
      prompts.tabGone(id)
    })
  }

  ipcMain.handle(AUTOFILL_QUERY, (event) => {
    const frame = frameRefOf(event)
    const offer = frame ? broker.offerFor(frame) : null
    return { usernames: offer?.usernames ?? [] }
  })

  ipcMain.handle(AUTOFILL_OFFER, (event, payload: unknown) => {
    const tab = autofillTab(event.sender.id)
    const frame = frameRefOf(event)
    if (!tab || !frame) return null
    if (tab.kind === 'user') {
      popMenu(broker, event, frame, payload, open)
      return null
    }
    const usernames = broker.offerInline(frame)
    if (!usernames) return null
    const id = event.sender.id
    if (!inlineTabs.has(id)) {
      inlineTabs.add(id)
      event.sender.once('destroyed', () => {
        inlineTabs.delete(id)
        broker.forgetTab(id)
      })
    }
    tab.notice(AGENT_NOTICE)
    return { usernames }
  })

  ipcMain.on(AUTOFILL_PICK, (event, payload: unknown) => {
    const frame = frameRefOf(event)
    const index = (payload as { index?: unknown } | null)?.index
    if (!frame || typeof index !== 'number' || !Number.isInteger(index)) return
    broker.pickInline(frame, index)
  })

  ipcMain.on(AUTOFILL_CAPTURE, (event, payload: unknown) => {
    const tab = autofillTab(event.sender.id)
    const frame = frameRefOf(event)
    if (!tab || !frame?.alive()) return
    const origin = fillableOrigin(frame.origin())
    const { username, password, current, step } = (payload ?? {}) as Record<string, unknown>
    if (!origin || typeof username !== 'string') return
    watch(event.sender)
    // 两步登录的第一步：只有用户名
    if (step === true) {
      prompts.step(event.sender.id, origin, username)
      return
    }
    if (typeof password !== 'string') return
    const sender = event.senderFrame
    prompts.capture(event.sender.id, tab.info(), {
      origin,
      frame: sender?.parent ? sender.frameTreeNodeId : null,
      username,
      password,
      ...(typeof current === 'string' && current !== '' ? { current } : {}),
    })
  })
  return broker
}
