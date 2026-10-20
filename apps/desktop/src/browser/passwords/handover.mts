// 把代理的标签交给人登录（request_sign_in 的真的那一份，executor.mts 的 BrowserHandover）：
// 1. 先冻结：执行器拒绝代理对这个标签的一切调用（tabs list 里也只给占位），标签自己的 CDP 一条都不发、调试器断开，
//    控制台和提示不收（electron-tab.mts），自动填充按用户的标签对待（原生菜单，能用已保存的密码），
//    网页开的弹窗开成用户的标签（electron-host.mts，单点登录常用），代理同样碰不到；
// 2. 代理在这个标签里执行过脚本（evaluate，不管是不是当前文档，往返缓存会把旧文档恢复回来）就重新打开一次：
//    冻结之后才做，中间不留空档；用 GET 打开当前地址，免得把 POST 的结果页再提交一次；
// 3. 打开浏览器面板、切到这个标签，面板上出“代理请你登录”的卡片（signin.mts），醒目的是主进程取到的真实来源，
//    随导航更新；代理填的站点名和原因只作附注；
// 4. 等人点“完成，交还”或“取消”；没人在看就一直等。标签关了就撤掉卡片；
// 5. 人答了：请标签里每个框架的预加载清空当过密码框的和人输过字的框。有框架没回、或者有预加载够不着的框
//    （封闭的影子树里的）时不照样交还，改成重新打开这一页；交接期间开的弹窗关掉；控制台和提示清空；然后解冻；
// 6. 代理不等了（回合打断、结束、断线）：不悄悄交还。重新打开这一页、关掉弹窗，卡片变成“代理已收回，别再在这里输入”。
// 给代理的结果只说是哪一种，不带人输入的任何东西。
import { type IpcMainEvent, type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron'
import type { HostTab } from '../electron-tab.mjs'
import type { BrowserHandover, SignInOutcome } from '../executor.mjs'
import type { BrowserHost, BrowserPage } from '../model.mjs'
import { type DomNode, hasClosedShadowFields } from './dom-tree.mjs'
import {
  AUTOFILL_CLEAR,
  AUTOFILL_CLEARED,
  SIGNIN_ANSWER,
  SIGNIN_CHANGED,
  SIGNIN_LIST,
} from './ipc.mjs'
import type { SignIns } from './signin.mjs'
import { isHandoverPopup, setHandedOver, takePopups } from './tabs.mjs'

/** 重新打开最多等多久 */
const RELOAD_MS = 15_000
/** 等各框架清完最多等多久 */
const CLEAR_MS = 1500

/** 清框的回声：口令 → 还差哪几个框架 */
const clearing = new Map<string, { left: Set<string>; done(): void }>()
let clearSeq = 0
let listening = false

const frameKey = (processId: number, routingId: number) => `${processId}:${routingId}`

const originOf = (url: string): string => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : ''
  } catch {
    return ''
  }
}

/** 请标签里每个框架清框。都回了（true），到点还有没回的（false） */
function clearFrames(contents: WebContents, since: number): Promise<boolean> {
  if (!listening) {
    listening = true
    ipcMain.on(AUTOFILL_CLEARED, (event, payload: unknown) => {
      const token = (payload as { token?: unknown } | null)?.token
      const frame = event.senderFrame
      if (typeof token !== 'string' || !frame) return
      const one = clearing.get(token)
      if (!one) return
      one.left.delete(frameKey(frame.processId, frame.routingId))
      if (one.left.size === 0) one.done()
    })
  }
  if (contents.isDestroyed()) return Promise.resolve(true)
  const frames = contents.mainFrame.framesInSubtree.filter((frame) => !frame.detached)
  const token = `clear-${++clearSeq}`
  return new Promise<boolean>((resolve) => {
    const left = new Set(frames.map((frame) => frameKey(frame.processId, frame.routingId)))
    const finish = () => {
      clearTimeout(timer)
      clearing.delete(token)
      resolve(left.size === 0)
    }
    const timer = setTimeout(finish, CLEAR_MS)
    clearing.set(token, { left, done: finish })
    for (const frame of frames) {
      try {
        frame.send(AUTOFILL_CLEAR, { token, since })
      } catch {
        // 框架这会儿没了：留在 left 里，当作没清到
      }
    }
    if (frames.length === 0) finish()
  })
}

/** 页面里有没有预加载够不着的输入框（封闭的影子树里的）。看不了也当有 */
async function unreachableFields(contents: WebContents): Promise<boolean> {
  const debug = contents.debugger
  const attached = debug.isAttached()
  try {
    if (!attached) debug.attach('1.3')
    const { root } = (await debug.sendCommand('DOM.getDocument', { depth: -1, pierce: true })) as {
      root: DomNode
    }
    return hasClosedShadowFields(root)
  } catch {
    return true
  } finally {
    if (!attached) {
      try {
        debug.detach()
      } catch {
        // 已经断开了
      }
    }
  }
}

/** 换一个新文档：GET 打开当前地址（不重复提交 POST）；没换成就重新载入。回换成了没有 */
async function refresh(page: BrowserPage, contents: WebContents): Promise<boolean> {
  let navigated = false
  const on = () => {
    navigated = true
  }
  contents.on('did-navigate', on)
  try {
    const url = contents.getURL()
    if (originOf(url)) await page.load(url, RELOAD_MS)
    if (!navigated && !contents.isDestroyed()) await page.history('reload', RELOAD_MS)
    return navigated
  } finally {
    if (!contents.isDestroyed()) contents.removeListener('did-navigate', on)
  }
}

export function createHandover(options: { host: BrowserHost; signIns: SignIns }): BrowserHandover {
  const { host, signIns } = options
  /** 冻结着的标签（从冻结到解冻） */
  const frozen = new Set<string>()
  /** 代理执行过脚本、还没重新打开过的标签 */
  const scripted = new Set<string>()

  const contentsOf = (tabId: string): WebContents | null => {
    const page = host.page(tabId) as HostTab | undefined
    const contents = page?.view?.webContents
    return contents && !contents.isDestroyed() ? contents : null
  }

  /** 交接期间开的弹窗关掉 */
  const closePopups = (contents: WebContents) => {
    for (const id of takePopups(contents.id)) host.close(id)
  }

  /** 解冻前：冻结期间攒下的控制台和提示不给代理 */
  const forget = (page: BrowserPage) => {
    page.clearConsole()
    page.takeNotices()
  }

  return {
    active: (tabId) => frozen.has(tabId),
    hides: (tabId) => frozen.has(tabId) || isHandoverPopup(tabId),
    markScripted(tabId) {
      scripted.add(tabId)
    },
    async request(page, ask, signal): Promise<SignInOutcome> {
      const contents = contentsOf(page.id)
      if (!contents) return 'closed'
      // 先冻结，再重新打开：中间不留代理能动手的空档
      frozen.add(page.id)
      setHandedOver(contents.id, true)
      ;(page as HostTab).release?.()
      const unfreeze = () => {
        if (!contents.isDestroyed()) {
          forget(page)
          setHandedOver(contents.id, false)
        }
        frozen.delete(page.id)
      }
      try {
        if (scripted.has(page.id) && (await refresh(page, contents))) scripted.delete(page.id)
      } catch {
        // 打不开也接着交给人：脚本留下的东西最多是在这一页上
      }
      if (contents.isDestroyed()) {
        frozen.delete(page.id)
        return 'closed'
      }
      if (signal.aborted) {
        closePopups(contents)
        unfreeze()
        return 'aborted'
      }
      const begun = signIns.begin({
        owner: page.info().owner,
        tabId: page.id,
        origin: originOf(contents.getURL()),
        site: ask.site,
        reason: ask.reason,
      })
      if (!begun) {
        unfreeze()
        return 'aborted'
      }
      const since = Date.now()
      // 卡片上的来源跟着这个标签的导航走
      const follow = () => signIns.setOrigin(begun.id, originOf(contents.getURL()))
      contents.on('did-navigate', follow)
      contents.on('did-navigate-in-page', follow)
      host.show(page.id)

      let stop: (outcome: SignInOutcome) => void = () => {}
      const stopped = new Promise<SignInOutcome>((resolve) => {
        stop = resolve
      })
      const onAbort = () => stop('aborted')
      const onGone = () => stop('closed')
      signal.addEventListener('abort', onAbort, { once: true })
      contents.once('destroyed', onGone)
      let outcome: SignInOutcome = 'aborted'
      try {
        outcome = await Promise.race([begun.answered, stopped])
      } finally {
        signal.removeEventListener('abort', onAbort)
        if (!contents.isDestroyed()) {
          contents.removeListener('destroyed', onGone)
          contents.removeListener('did-navigate', follow)
          contents.removeListener('did-navigate-in-page', follow)
        }
      }
      if (outcome === 'closed' || contents.isDestroyed()) {
        signIns.tabGone(page.id)
        takePopups(contents.id)
        frozen.delete(page.id)
        return 'closed'
      }
      closePopups(contents)
      if (outcome === 'aborted') {
        // 代理不等了：不悄悄交还。卡片变成“代理已收回”，这一页重新打开，丢掉人输到一半的东西
        signIns.withdraw(begun.id)
        await refresh(page, contents).catch(() => false)
        unfreeze()
        return 'aborted'
      }
      signIns.end(begun.id)
      // 清框：有框架没回、有预加载够不着的框，就重新打开这一页
      const cleared = await clearFrames(contents, since)
      if (!contents.isDestroyed() && (!cleared || (await unreachableFields(contents)))) {
        await refresh(page, contents).catch(() => false)
      }
      if (contents.isDestroyed()) {
        frozen.delete(page.id)
        return 'closed'
      }
      unfreeze()
      return outcome
    },
  }
}

/** 界面那一头：列“代理请你登录”、答交还、取消或“知道了”，变了推给所有窗口 */
export function installSignInIpc(options: {
  signIns: SignIns
  fromUi(event: IpcMainEvent | IpcMainInvokeEvent): boolean
  broadcast(channel: string, payload: unknown): void
}): void {
  const { signIns } = options
  signIns.onChange((list) => options.broadcast(SIGNIN_CHANGED, list))
  ipcMain.handle(SIGNIN_LIST, (event) => (options.fromUi(event) ? signIns.list() : []))
  ipcMain.handle(SIGNIN_ANSWER, (event, payload: unknown) => {
    if (!options.fromUi(event)) return false
    const { id, answer } = (payload ?? {}) as { id?: unknown; answer?: unknown }
    if (typeof id !== 'string') return false
    if (answer !== 'done' && answer !== 'cancel' && answer !== 'dismiss') return false
    return signIns.answer(id, answer)
  })
}
