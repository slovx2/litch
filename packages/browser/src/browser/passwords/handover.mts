// 手动登录交接：冻结观察、交给用户、清框后交还；不访问密码库，不接受代理代填。
import { ipcMain, type WebContents } from 'electron'
import type { ClientToolAsk } from '../../tool-port.mjs'
import type { HostTab } from '../electron-tab.mjs'
import type { BrowserHandover, SignInOutcome } from '../executor.mjs'
import type { BrowserHost, BrowserPage } from '../model.mjs'
import { type DomNode, hasClosedShadowFields } from './dom-tree.mjs'
import { refreshHandoverPage } from './handover-refresh.mjs'
import { AUTOFILL_CLEAR, AUTOFILL_CLEARED } from './ipc.mjs'
import type { SignInRequest, SignInResolution, SignIns } from './signin.mjs'
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

export interface HandoverOptions {
  host: BrowserHost
  signIns: SignIns
  log?(line: string): void
}

/** 定时任务的回合，卡片多久没人答就过期 */
export const TASK_CARD_MS = 30 * 60_000
const sessionOf = (owner: { deviceId: string; threadId: string }) =>
  `${owner.deviceId}\u0000${owner.threadId}`

/** 对话里的那张卡片（和面板上的同一张，ClientToolAsk 的 signIn） */
const askOf = (
  card: SignInRequest,
  task: { id: string; name: string } | null,
  desktopId: string | null,
): ClientToolAsk => ({
  kind: 'signIn',
  id: card.id,
  origin: card.origin,
  site: card.site,
  reason: card.reason,
  accounts: card.accounts.map((one) => ({ ...one })),
  fillBlocked: card.fillBlocked,
  taskId: card.taskId,
  task,
  expiresAt: card.expiresAt,
  nonce: card.nonce,
  desktopId,
})

export function createHandover(options: HandoverOptions): BrowserHandover {
  const { host, signIns } = options
  /** 冻结着的标签（从冻结到解冻，或到关掉） */
  const frozen = new Set<string>()
  /** 代理执行过脚本、还没重新打开过的标签 */
  const scripted = new Set<string>()
  /** 会话 → 这一回合里人拒绝过的源 */
  const declined = new Map<string, { turnId: string; origins: Set<string> }>()
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

  const wasDeclined = (session: string, turnId: string, origin: string) => {
    const one = declined.get(session)
    return one?.turnId === turnId && one.origins.has(origin)
  }
  const noteDeclined = (session: string, turnId: string, origin: string) => {
    let one = declined.get(session)
    if (one?.turnId !== turnId) declined.set(session, (one = { turnId, origins: new Set() }))
    one.origins.add(origin)
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
    turnEnded(session, turnId) {
      if (declined.get(session)?.turnId === turnId) declined.delete(session)
    },
    async request(page, ask, signal): Promise<SignInOutcome> {
      const contents = contentsOf(page.id)
      if (!contents) return 'closed'
      // 已经交给人了（同一个标签前后脚两次调用）：不动那一次交接的任何状态
      if (frozen.has(page.id)) return 'busy'
      const contentsId = contents.id
      const owner = page.info().owner
      const session = sessionOf(owner)
      // 代理给的源和页面的真实源不一样：不出卡片
      if (ask.origin !== null && ask.origin !== originOf(contents.getURL())) return 'origin_changed'
      if (wasDeclined(session, ask.turnId, originOf(contents.getURL()))) return 'declined'
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
          // 清掉这个标签的历史（连带往返缓存）：不然后退会原样拿回填过密码、人输过密码的那一页
          contents.navigationHistory.clear()
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
        if (!(await refreshHandoverPage(host, page, contents, RELOAD_MS))) return fail()
        scripted.delete(page.id)
        // 重新载入后编号的标记没了：按 Litch 自己的识别
      }
      if (contents.isDestroyed()) return gone()
      if (signal.aborted) {
        closePopups(contentsId)
        unfreeze()
        return 'aborted'
      }
      const origin = originOf(contents.getURL())
      const since = Date.now()
      const begun = signIns.begin({
        owner,
        tabId: page.id,
        origin,
        site: ask.site,
        reason: ask.reason,
        taskId: ask.task?.id ?? null,
        expiresInMs: ask.task ? TASK_CARD_MS : null,
      })
      if (!begun) {
        // 这个标签已经有一张在等的卡片（不该有，冻结名单先挡住了）：不解冻，按打不开处理，关掉标签
        return fail()
      }
      // 手动登录导航只更新来源，不读取账号或预检代填。
      const follow = () => signIns.setOrigin(begun.id, originOf(contents.getURL()))
      contents.on('did-navigate', follow)
      contents.on('did-navigate-in-page', follow)
      host.show(page.id)

      // 对话里同样挂一张（只在等人选的时候）；来源、能不能代填变了就换一张
      let retract: (() => void) | null = null
      let mirrored = ''
      const mirror = () => {
        const card = signIns.get(begun.id)
        const want = card && card.state === 'waiting' && card.stage === 'choose' ? card : null
        const key = want ? `${want.origin}\u0000${want.fillBlocked}` : ''
        if (key === mirrored) return
        retract?.()
        retract = null
        mirrored = key
        if (want && ask.show) {
          retract = ask.show(askOf(want, ask.task, null), (answer) => {
            // 核心那条路回来的拒绝（界面本该走浏览器桥）
            if (answer === 'decline') signIns.answer(begun.id, 'cancel')
          })
        }
      }
      const unmirror = signIns.onChange(mirror)
      mirror()

      let stop: (outcome: 'aborted' | 'closed') => void = () => {}
      const stopped = new Promise<'aborted' | 'closed'>((resolve) => {
        stop = resolve
      })
      const onAbort = () => stop('aborted')
      const onGone = () => stop('closed')
      signal.addEventListener('abort', onAbort, { once: true })
      contents.once('destroyed', onGone)
      let resolution: SignInResolution | 'aborted' | 'closed' = 'aborted'
      try {
        resolution = await Promise.race([begun.answered, stopped])
      } finally {
        signal.removeEventListener('abort', onAbort)
        unmirror()
        ;(retract as (() => void) | null)?.()
        if (!contents.isDestroyed()) {
          contents.removeListener('destroyed', onGone)
          contents.removeListener('did-navigate', follow)
          contents.removeListener('did-navigate-in-page', follow)
        }
      }
      if (resolution === 'closed' || contents.isDestroyed()) return gone()

      contents.on('before-input-event', holdKeys)
      closePopups(contentsId)
      if (resolution === 'aborted') {
        // 代理不等了：不悄悄交还。卡片变成“代理已收回”；先清一遍框，再重新打开这一页，丢掉人输到一半的东西
        signIns.withdraw(begun.id)
        await clearFrames(contents, since)
        if (!(await refreshHandoverPage(host, page, contents, RELOAD_MS))) return fail()
        unfreeze()
        return 'aborted'
      }
      signIns.end(begun.id)
      if (resolution.kind === 'cancel') noteDeclined(session, ask.turnId, origin)
      // 清框：有框架没回、有预加载够不着的框，就重新打开这一页；打不开就关掉标签
      const cleared = await clearFrames(contents, since)
      if (contents.isDestroyed()) return gone()
      if (!cleared || (await unreachableFields(contents))) {
        if (!(await refreshHandoverPage(host, page, contents, RELOAD_MS))) return fail()
      }
      if (contents.isDestroyed()) return gone()
      unfreeze()
      return resolution.kind === 'done'
        ? 'done'
        : resolution.kind === 'cancel'
          ? 'cancel'
          : 'expired'
    },
  }
}
