// 把代理的标签交给人登录（request_sign_in 的真的那一份，executor.mts 的 BrowserHandover）：
// 1. 先冻结：执行器拒绝代理对这个标签的一切调用（tabs list 里也只给占位），标签自己的 CDP 一条都不发、调试器断开，
//    控制台和提示不收（electron-tab.mts），自动填充按用户的标签对待（原生菜单，能用已保存的密码），
//    网页开的弹窗开成用户的标签（electron-host.mts，单点登录常用），代理同样碰不到；
// 2. 代理在这个标签里执行过脚本（evaluate，不管是不是当前文档，往返缓存会把旧文档恢复回来）就重新打开一次：
//    冻结之后才做，中间不留空档；用 GET 打开当前地址，免得把 POST 的结果页再提交一次；网页装的 beforeunload 拦不住；
//    打不开（没换成新文档）就不交给人，关掉这个标签，留一张“标签已关掉”的卡片说明；
// 3. 打开浏览器面板、切到这个标签，面板上出“代理请你登录”的卡片（signin.mts），对话里也挂一张同样的（只在等人选时）。
//    醒目的是主进程取到的真实来源，随导航更新；代理填的站点名和原因只作附注。卡片列密码库里和这个源完全一样的账号，
//    出卡片时预检一遍（导航后再预检），不过的“用账号登录”置灰写原因。手机的答复验过签名才认（phone-answer.mts）；
// 4. 等人选：用账号登录（Litch 代填，见 7）、我自己登录（等人点“完成，交还”或“取消”）、拒绝；没人在看就一直等，
//    定时任务的回合 30 分钟过期。标签关了就撤掉卡片、关掉交接期间开的弹窗（弹窗里再开的也算）；
// 5. 人自己登录完、拒绝、过期：请标签里每个框架的预加载清空当过密码框的和人输过字的框。有框架没回、或者有预加载
//    够不着的框（封闭的影子树里的）时不照样交还，改成重新打开这一页，打不开就关掉标签；交接期间开的弹窗关掉；
//    人答了之后键盘输入先停掉，清框到解冻之间再输的不留下；控制台和提示清空；然后解冻。
//    残余风险：网页自己把密码框的值抄进别的框（两个框式的“显示密码”），抄进的框人没在里面输过字，清不到；
//    代理执行过脚本的会先重新打开，剩下的是网页本身的行为，和人在用户标签里用同一个网页一样；
// 6. 代理不等了（回合打断、结束、断线）：不悄悄交还。关掉弹窗、先清一遍框、再重新打开这一页（打不开同上，关掉标签），
//    卡片变成“代理已收回，别再在这里输入”；之后标签被关掉（比如回合结束关代理的标签）卡片随它撤掉；
// 7. Litch 代填（sign-in-fill.mts）：开观察闸（网页的弹窗不开、登录提交不出保存提示，冻结时的那些照旧），
//    再预检一遍，主进程解开这一条只送进登录框所在的框架，填好提交、等落定，请各框架清框自检；干净就解闸，
//    不干净（或地址里带着密码）就关掉这个标签、在新标签里开同一地址。上一次代填后要验证码的标签，下一次只给“我自己登录”。
//    定时任务事先授权过的（options.preauthorized）不出卡片，直接这样代填。
// 同一回合里人拒绝过的源，代理再请求直接回拒绝，不再出卡片。
// 给代理的结果只说是哪一种，不带人输入的任何东西，也不带用户名。
import { randomUUID } from 'node:crypto'
import { ipcMain, type WebContents } from 'electron'
import type { ClientToolAsk } from '../../client-tools/types.mjs'
import type { HostTab } from '../electron-tab.mjs'
import type { BrowserHandover, SignInOutcome } from '../executor.mjs'
import type { BrowserHost, BrowserPage } from '../model.mjs'
import { type DomNode, hasClosedShadowFields } from './dom-tree.mjs'
import { AUTOFILL_CLEAR, AUTOFILL_CLEARED } from './ipc.mjs'
import { fillableOrigin } from './origin.mjs'
import {
  type PhoneAnswerVerdict,
  phoneAnswerCardId,
  rejectPhoneAnswers,
  type VerifyPhoneAnswer,
} from './phone-answer.mjs'
import { fillTab, probeTab } from './sign-in-fill.mjs'
import type { SignInBlock, SignInBy, SignInRequest, SignInResolution, SignIns } from './signin.mjs'
import type { PasswordStore } from './store.mjs'
import { isHandoverPopup, setGated, setHandedOver, takePopups } from './tabs.mjs'

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

export interface HandoverOptions {
  host: BrowserHost
  signIns: SignIns
  /** 密码库（建得比交接晚，取的时候再拿）；没有就不出可代填的账号 */
  store?: () => PasswordStore | null
  /** 手机答复的验签（approvals/verify.mts）；不给一律不认 */
  verifyPhoneAnswer?: VerifyPhoneAnswer
  /**
   * 定时任务的事先授权：设备、任务、源对上一条授权时回条目号（grants/），不出卡片直接代填；没有回 null
   */
  preauthorized?(input: { deviceId: string; taskId: string; origin: string }): string | null
  /** 人在定时任务的卡片上勾了“以后直接用这个账号”，代填成功后调：记下这条授权 */
  remember?(input: {
    deviceId: string
    taskId: string
    taskName: string
    origin: string
    entryId: string
    by: SignInBy
  }): void
  log?(line: string): void
}

/** 定时任务的回合，卡片多久没人答就过期 */
export const TASK_CARD_MS = 30 * 60_000
/** 出卡片后页面导航了，隔多久重新预检一次 */
const REPROBE_MS = 400

const sessionOf = (owner: { deviceId: string; threadId: string }) =>
  `${owner.deviceId}\u0000${owner.threadId}`

/** 对话里的那张卡片（和面板上的同一张，ClientToolAsk 的 signIn） */
const askOf = (card: SignInRequest): ClientToolAsk => ({
  kind: 'signIn',
  id: card.id,
  origin: card.origin,
  site: card.site,
  reason: card.reason,
  accounts: card.accounts.map((one) => ({ ...one })),
  fillBlocked: card.fillBlocked,
  taskId: card.taskId,
  expiresAt: card.expiresAt,
  nonce: card.nonce,
})

/** 这个标签有开它的窗口（同源的父子窗口能直接读彼此的网页） */
const related = (contents: WebContents): boolean => {
  try {
    return contents.opener !== null
  } catch {
    return true
  }
}

export function createHandover(options: HandoverOptions): BrowserHandover {
  const { host, signIns } = options
  const log = options.log ?? ((line: string) => console.error(`[sign-in] ${line}`))
  const verify = options.verifyPhoneAnswer ?? rejectPhoneAnswers
  /** 冻结着的标签（从冻结到解冻，或到关掉） */
  const frozen = new Set<string>()
  /** 代理执行过脚本、还没重新打开过的标签 */
  const scripted = new Set<string>()
  /** 上一次代填后要验证码的标签：下一次请求只给“我自己登录” */
  const verifying = new Set<string>()
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
      verifying.delete(tabId)
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

  /** 出卡片时的预检：能不能代填（不开代填，人自己登录时照常出保存提示） */
  const cardBlock = async (
    contents: WebContents,
    origin: string,
    hintToken: string | null,
    entries: string[],
  ): Promise<SignInBlock | null> => {
    if (entries.length === 0) return null
    const store = options.store?.() ?? null
    const seen = await probeTab(contents, {
      token: randomUUID(),
      hintToken,
      begin: false,
      pageOrigin: origin,
      related: related(contents),
      allowAction: (target) => entries.some((id) => store?.actionOriginOf(id) === target),
    })
    return seen.block === 'no_answer' ? 'no_form' : seen.block
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
    async phoneAnswer(answer) {
      const id = phoneAnswerCardId(answer)
      const card = id ? signIns.get(id) : null
      if (card?.state !== 'waiting' || card.stage !== 'choose') return
      let verdict: PhoneAnswerVerdict
      try {
        verdict = await verify(
          {
            id: card.id,
            nonce: card.nonce,
            origin: card.origin,
            accounts: card.accounts,
            taskId: card.taskId,
            expiresAt: card.expiresAt,
          },
          answer,
        )
      } catch (error) {
        log(`验手机答复出错：${String(error)}`)
        return
      }
      if (!verdict.ok) {
        log(`手机答复没认：${verdict.why}`)
        return
      }
      const by = { phoneId: verdict.phoneId }
      if (verdict.choice === null) signIns.answer(card.id, 'cancel', by)
      else signIns.answer(card.id, { fill: verdict.choice, remember: verdict.remember }, by)
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
      let hintToken = ask.hintToken
      /** 人答了之后先停掉键盘输入：清框到解冻之间再输的不留下 */
      const holdKeys = (event: Electron.Event) => event.preventDefault()
      const unfreeze = () => {
        if (!contents.isDestroyed()) {
          contents.removeListener('before-input-event', holdKeys)
          forget(page)
          setGated(contentsId, false)
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
      /** 代填后自检不干净：关掉这个标签，在新标签里打开 url（不继承旧文档的任何东西），回新标签 */
      const reopen = async (url: string): Promise<string> => {
        const info = page.info()
        closePopups(contentsId)
        host.close(page.id)
        frozen.delete(page.id)
        const next = host.open(info.owner, 'agent', { keep: info.keep })
        await next.load(url, RELOAD_MS).catch(() => {})
        return next.id
      }
      if (scripted.has(page.id)) {
        if (!(await refresh(page, contents))) return fail()
        scripted.delete(page.id)
        // 重新载入后编号的标记没了：按 Litch 自己的识别
        hintToken = null
      }
      if (contents.isDestroyed()) return gone()
      if (signal.aborted) {
        closePopups(contentsId)
        unfreeze()
        return 'aborted'
      }
      const origin = originOf(contents.getURL())
      const since = Date.now()
      const store = options.store?.() ?? null
      const lastVerifying = verifying.has(page.id)
      verifying.delete(page.id)

      /** Litch 代填（人批准的，或定时任务事先授权的），落定后解闸或关掉重开 */
      const runFill = async (entryId: string, preauthorized: boolean): Promise<SignInOutcome> => {
        if (!store) return { kind: 'fillFailed', why: 'unavailable', reopened: null }
        setGated(contentsId, true)
        const report = await fillTab({
          contents,
          store,
          entryId,
          origin,
          hintToken,
          submitHint: ask.submitHint,
          related: () => related(contents),
          since,
        })
        if (report.gone || contents.isDestroyed()) return gone()
        let reopened: string | null = null
        if (report.clean) unfreeze()
        else reopened = await reopen(report.reopenAt)
        const tabId = reopened ?? page.id
        const verification = report.submitted && report.otp
        if (verification) verifying.add(tabId)
        if (report.failure) return { kind: 'fillFailed', why: report.failure, reopened }
        const landedUrl = host.page(tabId)?.info().url ?? ''
        return {
          kind: 'filled',
          origin: originOf(landedUrl),
          navigated: report.navigated,
          reopened,
          verification,
          stillSignIn: report.loginForm && !verification,
          preauthorized,
        }
      }

      // 定时任务事先授权过这个站、这个账号：预检过了就不出卡片，直接代填（预检不过照常出卡片）
      const granted =
        ask.task && store
          ? (options.preauthorized?.({ deviceId: owner.deviceId, taskId: ask.task.id, origin }) ??
            null)
          : null
      if (granted && store?.candidates(origin).some((one) => one.id === granted)) {
        const block = await cardBlock(contents, origin, hintToken, [granted])
        if (contents.isDestroyed()) return gone()
        if (block === null && !lastVerifying) return runFill(granted, true)
      }

      const fillable = fillableOrigin(origin) !== null
      const candidates = store && fillable ? store.candidates(origin) : []
      const entries = candidates.map((one) => one.id)
      const block = lastVerifying
        ? 'verification'
        : await cardBlock(contents, origin, hintToken, entries)
      if (contents.isDestroyed()) return gone()
      const begun = signIns.begin({
        owner,
        tabId: page.id,
        origin,
        site: ask.site,
        reason: ask.reason,
        accounts: candidates.map((one) => ({
          entryId: one.id,
          username: one.username,
          lastUsed: one.lastUsedAt ?? null,
        })),
        fillBlocked: block,
        taskId: ask.task?.id ?? null,
        expiresInMs: ask.task ? TASK_CARD_MS : null,
      })
      if (!begun) {
        // 这个标签已经有一张在等的卡片（不该有，冻结名单先挡住了）：不解冻，按打不开处理，关掉标签
        return fail()
      }
      // 卡片上的来源跟着这个标签的导航走；还在等人选的，导航后重新预检
      let reprobe: ReturnType<typeof setTimeout> | undefined
      const follow = () => {
        const now = originOf(contents.getURL())
        signIns.setOrigin(begun.id, now)
        clearTimeout(reprobe)
        reprobe = setTimeout(() => {
          const card = signIns.get(begun.id)
          if (card?.stage !== 'choose' || contents.isDestroyed()) return
          if (originOf(contents.getURL()) !== origin) {
            signIns.setBlocked(begun.id, 'origin_changed')
            return
          }
          if (lastVerifying) return
          void cardBlock(contents, origin, null, entries).then((next) => {
            if (signIns.get(begun.id)?.stage === 'choose') signIns.setBlocked(begun.id, next)
          })
        }, REPROBE_MS)
      }
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
          retract = ask.show(askOf(want), (answer) => {
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
        clearTimeout(reprobe)
        unmirror()
        ;(retract as (() => void) | null)?.()
        if (!contents.isDestroyed()) {
          contents.removeListener('destroyed', onGone)
          contents.removeListener('did-navigate', follow)
          contents.removeListener('did-navigate-in-page', follow)
        }
      }
      if (resolution === 'closed' || contents.isDestroyed()) return gone()

      if (typeof resolution === 'object' && resolution.kind === 'fill') {
        // 代填期间卡片留着（filling），代填完撤掉；代理不等了也做完再收（中途停下更难收拾）
        try {
          const outcome = await runFill(resolution.entryId, false)
          if (
            resolution.remember &&
            ask.task &&
            typeof outcome === 'object' &&
            outcome.kind === 'filled' &&
            !outcome.verification
          ) {
            options.remember?.({
              deviceId: owner.deviceId,
              taskId: ask.task.id,
              taskName: ask.task.name,
              origin,
              entryId: resolution.entryId,
              by: resolution.by,
            })
          }
          return signal.aborted ? 'aborted' : outcome
        } finally {
          signIns.end(begun.id)
        }
      }

      contents.on('before-input-event', holdKeys)
      closePopups(contentsId)
      if (resolution === 'aborted') {
        // 代理不等了：不悄悄交还。卡片变成“代理已收回”；先清一遍框，再重新打开这一页，丢掉人输到一半的东西
        signIns.withdraw(begun.id)
        await clearFrames(contents, since)
        if (!(await refresh(page, contents))) return fail()
        unfreeze()
        return 'aborted'
      }
      signIns.end(begun.id)
      if (resolution.kind === 'cancel') noteDeclined(session, ask.turnId, origin)
      // 清框：有框架没回、有预加载够不着的框，就重新打开这一页；打不开就关掉标签
      const cleared = await clearFrames(contents, since)
      if (contents.isDestroyed()) return gone()
      if (!cleared || (await unreachableFields(contents))) {
        if (!(await refresh(page, contents))) return fail()
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
