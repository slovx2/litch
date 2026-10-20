// 把代理的标签交给人登录（request_sign_in 的真的那一份，executor.mts 的 BrowserHandover）：
// 1. 代理在当前文档里执行过脚本（evaluate）就先重新载入，换个新文档，丢掉它可能留下的监听；
// 2. 冻结：执行器拒绝代理对这个标签的一切调用，标签自己的 CDP 一条都不发、调试器断开（只认人真的在面板里的操作），
//    自动填充按用户的标签对待（原生菜单，能用已保存的密码）；
// 3. 打开浏览器面板、切到这个标签，面板上出“代理请你登录”的卡片（signin.mts 登记，经 SIGNIN_CHANGED 推给界面）；
// 4. 等人点“完成，交还”或“取消”，或者调用被中止（回合打断）、标签关了；没人在看就一直等；
// 5. 交还之前请标签里每个框架的预加载清空密码框（等它们回一声，最多等一会儿），然后解冻。
// 给代理的结果只说是哪一种，不带人输入的任何东西。
import { type IpcMainEvent, type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron'
import type { HostTab } from '../electron-tab.mjs'
import type { BrowserHandover, SignInOutcome } from '../executor.mjs'
import type { BrowserHost } from '../model.mjs'
import {
  AUTOFILL_CLEAR,
  AUTOFILL_CLEARED,
  SIGNIN_ANSWER,
  SIGNIN_CHANGED,
  SIGNIN_LIST,
} from './ipc.mjs'
import type { SignInAnswer, SignIns } from './signin.mjs'
import { setHandedOver } from './tabs.mjs'

/** 重新载入最多等多久 */
const RELOAD_MS = 15_000
/** 等各框架清完密码框最多等多久 */
const CLEAR_MS = 1500

/** 清密码框的回声：口令 → 还差哪几个框架 */
const clearing = new Map<string, { left: Set<string>; done(): void }>()
let clearSeq = 0
let listening = false

const frameKey = (processId: number, routingId: number) => `${processId}:${routingId}`

/** 请标签里每个框架清空密码框，都回了（或到点）就兑现 */
function clearPasswords(contents: WebContents): Promise<void> {
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
  if (contents.isDestroyed()) return Promise.resolve()
  const frames = contents.mainFrame.framesInSubtree.filter((frame) => !frame.detached)
  const token = `clear-${++clearSeq}`
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, CLEAR_MS)
    function finish() {
      clearTimeout(timer)
      clearing.delete(token)
      resolve()
    }
    clearing.set(token, {
      left: new Set(frames.map((frame) => frameKey(frame.processId, frame.routingId))),
      done: finish,
    })
    for (const frame of frames) {
      try {
        frame.send(AUTOFILL_CLEAR, { token })
      } catch {
        // 框架这会儿没了
      }
    }
    if (frames.length === 0) finish()
  })
}

export function createHandover(options: { host: BrowserHost; signIns: SignIns }): BrowserHandover {
  const { host, signIns } = options
  /** 冻结着的标签（从交出去到清完密码框） */
  const frozen = new Set<string>()
  /** 代理在当前文档里执行过脚本的标签 */
  const scripted = new Set<string>()
  /** 已经接上“换了文档就忘掉”的标签 */
  const watched = new Set<string>()

  const contentsOf = (tabId: string): WebContents | null => {
    const page = host.page(tabId) as HostTab | undefined
    const contents = page?.view?.webContents
    return contents && !contents.isDestroyed() ? contents : null
  }

  return {
    active: (tabId) => frozen.has(tabId),
    markScripted(tabId) {
      scripted.add(tabId)
      const contents = contentsOf(tabId)
      if (!contents || watched.has(tabId)) return
      watched.add(tabId)
      // 主框架换了文档（不算同一页里换地址），代理的脚本就跟着没了
      contents.on('did-navigate', () => scripted.delete(tabId))
      contents.once('destroyed', () => {
        scripted.delete(tabId)
        watched.delete(tabId)
      })
    },
    async request(page, ask, signal): Promise<SignInOutcome> {
      const contents = contentsOf(page.id)
      if (!contents) return 'closed'
      if (scripted.has(page.id)) {
        await page.history('reload', RELOAD_MS)
        scripted.delete(page.id)
      }
      if (signal.aborted) return 'aborted'
      const begun = signIns.begin({
        owner: page.info().owner,
        tabId: page.id,
        site: ask.site,
        reason: ask.reason,
      })
      if (!begun) return 'aborted'
      frozen.add(page.id)
      setHandedOver(contents.id, true)
      // 断开调试器、撤掉“代理在用”：这段时间标签是人的
      ;(page as HostTab).release?.()
      host.show(page.id)

      let stop: (outcome: SignInOutcome) => void = () => {}
      const stopped = new Promise<SignInOutcome>((resolve) => {
        stop = resolve
      })
      const onAbort = () => stop('aborted')
      const onGone = () => stop('closed')
      signal.addEventListener('abort', onAbort, { once: true })
      contents.once('destroyed', onGone)
      try {
        const outcome = await Promise.race([
          begun.answered.then((answer: SignInAnswer): SignInOutcome => answer),
          stopped,
        ])
        if (!contents.isDestroyed()) await clearPasswords(contents)
        return contents.isDestroyed() ? 'closed' : outcome
      } finally {
        signal.removeEventListener('abort', onAbort)
        if (!contents.isDestroyed()) contents.removeListener('destroyed', onGone)
        signIns.end(begun.id)
        setHandedOver(contents.id, false)
        frozen.delete(page.id)
      }
    },
  }
}

/** 界面那一头：列“代理请你登录”、答交还或取消，变了推给所有窗口 */
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
    if (typeof id !== 'string' || (answer !== 'done' && answer !== 'cancel')) return false
    return signIns.answer(id, answer)
  })
}
