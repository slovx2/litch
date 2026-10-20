// 把代理的标签交给人登录（request_sign_in 的真的那一份，executor.mts 的 BrowserHandover）：
// 1. 先冻结：执行器拒绝代理对这个标签的一切调用（tabs list 里也只给占位），标签自己的 CDP 一条都不发、调试器断开，
//    控制台和提示不收（electron-tab.mts），自动填充按用户的标签对待（原生菜单，能用已保存的密码），
//    网页开的弹窗开成用户的标签（electron-host.mts，单点登录常用），代理同样碰不到；
// 2. 代理在这个标签里执行过脚本（evaluate，不管是不是当前文档，往返缓存会把旧文档恢复回来）就重新打开一次：
//    冻结之后才做，中间不留空档；用 GET 打开当前地址，免得把 POST 的结果页再提交一次；网页装的 beforeunload 拦不住；
//    打不开（没换成新文档）就不交给人，关掉这个标签，留一张“标签已关掉”的卡片说明；
// 3. 打开浏览器面板、切到这个标签，面板上出“代理请你登录”的卡片（signin.mts），醒目的是主进程取到的真实来源，
//    随导航更新；代理填的站点名和原因只作附注；
// 4. 等人点“完成，交还”或“取消”；没人在看就一直等。标签关了就撤掉卡片、关掉交接期间开的弹窗（弹窗里再开的也算）；
// 5. 人答了：请标签里每个框架的预加载清空当过密码框的和人输过字的框。有框架没回、或者有预加载够不着的框
//    （封闭的影子树里的）时不照样交还，改成重新打开这一页，打不开就关掉标签；交接期间开的弹窗关掉；
//    人答了之后键盘输入先停掉，清框到解冻之间再输的不留下；控制台和提示清空；然后解冻。
//    残余风险：网页自己把密码框的值抄进别的框（两个框式的“显示密码”），抄进的框人没在里面输过字，清不到；
//    代理执行过脚本的会先重新打开，剩下的是网页本身的行为，和人在用户标签里用同一个网页一样；
// 6. 代理不等了（回合打断、结束、断线）：不悄悄交还。关掉弹窗、先清一遍框、再重新打开这一页（打不开同上，关掉标签），
//    卡片变成“代理已收回，别再在这里输入”；之后标签被关掉（比如回合结束关代理的标签）卡片随它撤掉。
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

/**
 * 换一个新文档，回换成了没有。网页的用 GET 打开当前地址：不重复提交 POST，没换成也不退回重新载入；
 * 别的（about:blank 之类，没有 POST）重新载入。网页装的 beforeunload 拦不住（will-prevent-unload 放行），
 * 不然代理用脚本装一个就能让这一页一直不换、把它的监听留过整个交接
 */
async function refresh(page: BrowserPage, contents: WebContents): Promise<boolean> {
  if (contents.isDestroyed()) return false
  let navigated = false
  const on = () => {
    navigated = true
  }
  const allow = (event: Electron.Event) => event.preventDefault()
  contents.on('did-navigate', on)
  contents.on('will-prevent-unload', allow)
  try {
    const url = contents.getURL()
    if (originOf(url)) await page.load(url, RELOAD_MS)
    else await page.history('reload', RELOAD_MS)
    return navigated && !contents.isDestroyed()
  } catch {
    return false
  } finally {
    if (!contents.isDestroyed()) {
      contents.removeListener('did-navigate', on)
      contents.removeListener('will-prevent-unload', allow)
    }
  }
}

export function createHandover(options: { host: BrowserHost; signIns: SignIns }): BrowserHandover {
  const { host, signIns } = options
  /** 冻结着的标签（从冻结到解冻，或到关掉） */
  const frozen = new Set<string>()
  /** 代理执行过脚本、还没重新打开过的标签 */
  const scripted = new Set<string>()
  /** 已经挂上“销毁时收拾”的标签 */
  const watched = new WeakSet<WebContents>()

  const contentsOf = (tabId: string): WebContents | null => {
    const page = host.page(tabId) as HostTab | undefined
    const contents = page?.view?.webContents
    return contents && !contents.isDestroyed() ? contents : null
  }

  /** 交接期间开的弹窗（连弹窗里再开的）关掉 */
  const closePopups = (contentsId: number) => {
    for (const id of takePopups(contentsId)) host.close(id)
  }

  /**
   * 标签销毁时收拾它留下的：执行过脚本的标记、冻结、弹窗、卡片（“代理已收回”的随标签撤掉，
   * 不留一张“显示”按钮指向不存在的标签的卡片；“标签已关掉”的留着）
   */
  const watch = (tabId: string, contents: WebContents) => {
    if (watched.has(contents)) return
    watched.add(contents)
    const contentsId = contents.id
    contents.once('destroyed', () => {
      scripted.delete(tabId)
      frozen.delete(tabId)
      closePopups(contentsId)
      signIns.tabGone(tabId)
    })
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
      const contents = contentsOf(tabId)
      if (!contents) return
      watch(tabId, contents)
      scripted.add(tabId)
    },
    async request(page, ask, signal): Promise<SignInOutcome> {
      const contents = contentsOf(page.id)
      if (!contents) return 'closed'
      // 已经交给人了（同一个标签前后脚两次调用）：不动那一次交接的任何状态
      if (frozen.has(page.id)) return 'busy'
      const contentsId = contents.id
      const owner = page.info().owner
      watch(page.id, contents)
      // 先冻结，再重新打开：中间不留代理能动手的空档
      frozen.add(page.id)
      setHandedOver(contentsId, true)
      ;(page as HostTab).release?.()
      // 面板上的后退、前进按钮跟着变灰（electron-tab.mts 的 info）
      ;(page as HostTab).handoverChanged?.()
      /** 人答了之后先停掉键盘输入：清框到解冻之间再输的不留下 */
      const holdKeys = (event: Electron.Event) => event.preventDefault()
      const unfreeze = () => {
        if (!contents.isDestroyed()) {
          contents.removeListener('before-input-event', holdKeys)
          forget(page)
          setHandedOver(contentsId, false)
          ;(page as HostTab).handoverChanged?.()
        }
        // 收尾到解冻之间网页又开的弹窗也关掉（先撤掉交出去的标记，之后开的不再记进来）
        closePopups(contentsId)
        frozen.delete(page.id)
      }
      /** 标签已经没了（人关的、回合结束关的）：卡片、弹窗随它撤掉 */
      const gone = (): SignInOutcome => {
        signIns.tabGone(page.id)
        closePopups(contentsId)
        frozen.delete(page.id)
        return 'closed'
      }
      /**
       * 没能安全地换成新文档：不交给人、不解冻，关掉这个标签（冻结到关掉为止），卡片说明为什么。
       * 标签在这中间没了就按没了算
       */
      const fail = (): SignInOutcome => {
        if (contents.isDestroyed()) return gone()
        signIns.closed({
          owner,
          tabId: page.id,
          origin: originOf(contents.getURL()),
          site: ask.site,
          reason: ask.reason,
        })
        closePopups(contentsId)
        host.close(page.id)
        frozen.delete(page.id)
        return 'failed'
      }
      if (scripted.has(page.id)) {
        if (!(await refresh(page, contents))) return fail()
        scripted.delete(page.id)
      }
      if (contents.isDestroyed()) return gone()
      if (signal.aborted) {
        closePopups(contentsId)
        unfreeze()
        return 'aborted'
      }
      const begun = signIns.begin({
        owner,
        tabId: page.id,
        origin: originOf(contents.getURL()),
        site: ask.site,
        reason: ask.reason,
      })
      if (!begun) {
        // 这个标签已经有一张在等的卡片（不该有，冻结名单先挡住了）：不解冻，按打不开处理，关掉标签
        return fail()
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
      if (outcome === 'closed' || contents.isDestroyed()) return gone()
      contents.on('before-input-event', holdKeys)
      closePopups(contentsId)
      if (outcome === 'aborted') {
        // 代理不等了：不悄悄交还。卡片变成“代理已收回”；先清一遍框，再重新打开这一页，丢掉人输到一半的东西
        signIns.withdraw(begun.id)
        await clearFrames(contents, since)
        if (!(await refresh(page, contents))) return fail()
        unfreeze()
        return 'aborted'
      }
      signIns.end(begun.id)
      // 清框：有框架没回、有预加载够不着的框，就重新打开这一页；打不开就关掉标签
      const cleared = await clearFrames(contents, since)
      if (contents.isDestroyed()) return gone()
      if (!cleared || (await unreachableFields(contents))) {
        if (!(await refresh(page, contents))) return fail()
      }
      if (contents.isDestroyed()) return gone()
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
