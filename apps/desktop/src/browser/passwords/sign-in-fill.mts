// Litch 代填在主进程这一侧（人在登录卡片上选了已存的账号之后，handover.mts 调）：
// 一步一步请登录框所在框架的预加载（sign-in-page.mts）认表单、填、提交，等页面落定，再请各框架清框自检。
// 不经 CDP：冻结期间调试器是断开的。真的按键、点击用 webContents.sendInputEvent，补字用 insertText。
// 密码只在 reveal 到送出那一步之间在这里，只送进认出登录框的那一个框架；自检给各框架的是滚动哈希（fill-rules.mts）。
// 两步登录（先只有用户名框）一次做完：填用户名、提交，等密码框出来（同一文档里或换了文档），最多等 15 秒、看两次。
import { randomInt, randomUUID } from 'node:crypto'
import { ipcMain, type WebContents, type WebFrameMain } from 'electron'
import {
  type FillFailure,
  type LoginReport,
  preflight,
  reopenUrl,
  type SecretProbe,
  secretFinder,
  secretProbe,
  urlHasSecret,
} from './fill-rules.mjs'
import { SIGNIN_PAGE, SIGNIN_PAGE_REPLY } from './ipc.mjs'
import type { SignInBlock } from './signin.mjs'
import type { PasswordStore } from './store.mjs'
import { popupWasTried } from './tabs.mjs'

/** 一步最多等框架多久 */
const STEP_MS = 1500
/** 提交后页面静止多久算落定（同一页里换地址、开始加载都算动静） */
const QUIET_MS = 2000
/** 提交后最多等多久（没换文档时） */
const SETTLE_MS = 8000
/** 换了文档之后等它加载完最多多久 */
const LOAD_MS = 15_000
/** 两步登录等密码框最多多久 */
const STEP_TWO_MS = 15_000
/** 按回车、点按钮之后等多久再看要不要 requestSubmit 兜底 */
const SUBMIT_GRACE_MS = 400

export interface FillReport {
  /** 标签在这中间没了 */
  gone: boolean
  /** 交上去了（两步登录至少交了第一步） */
  submitted: boolean
  failure: FillFailure | null
  /** 主框架换了文档 */
  navigated: boolean
  /** 落定后页面上有验证码、二次验证的框 */
  otp: boolean
  /** 落定后页面上还有密码框（多半没登上） */
  loginForm: boolean
  /** 清框自检都干净、地址里也没有：可以解闸；不干净要关掉重开 */
  clean: boolean
  /** 关掉重开时开的地址 */
  reopenAt: string
}

const frameKey = (frame: WebFrameMain) => `${frame.processId}:${frame.routingId}`
const pending = new Map<string, { key: string; resolve(result: unknown): void }>()
let listening = false
let seq = 0

/** 请一个框架做一步，等它回（只认那个框架回的）。没回、送不到回 undefined */
export function askFrame(
  frame: WebFrameMain,
  op: string,
  payload: Record<string, unknown>,
  timeoutMs = STEP_MS,
): Promise<unknown> {
  if (!listening) {
    listening = true
    ipcMain.on(SIGNIN_PAGE_REPLY, (event, message: unknown) => {
      const { rid, result } = (message ?? {}) as { rid?: unknown; result?: unknown }
      const sender = event.senderFrame
      if (typeof rid !== 'string' || !sender) return
      const one = pending.get(rid)
      if (!one || one.key !== frameKey(sender)) return
      pending.delete(rid)
      one.resolve(result)
    })
  }
  const rid = `s${++seq}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(rid)
      resolve(undefined)
    }, timeoutMs)
    pending.set(rid, {
      key: frameKey(frame),
      resolve: (result) => {
        clearTimeout(timer)
        resolve(result)
      },
    })
    try {
      frame.send(SIGNIN_PAGE, { rid, op, ...payload })
    } catch {
      clearTimeout(timer)
      pending.delete(rid)
      resolve(undefined)
    }
  })
}

const framesOf = (contents: WebContents): WebFrameMain[] =>
  contents.isDestroyed()
    ? []
    : contents.mainFrame.framesInSubtree.filter((frame) => {
        try {
          return !frame.detached && !frame.isDestroyed()
        } catch {
          return false
        }
      })

const isReport = (value: unknown): value is LoginReport =>
  !!value && typeof value === 'object' && typeof (value as LoginReport).form === 'string'

export interface TabProbe {
  /** 不能代填的原因；no_answer 是框架都没回 */
  block: SignInBlock | 'no_answer' | null
  frame: WebFrameMain | null
  report: LoginReport | null
}

/**
 * 认标签里的登录表单：请每个框架看一遍，挑出登录框所在的那一个，做预检。
 * pageOrigin 是卡片上的源（主框架的），allowAction 是条目记下的“交去的源”（不同站也认）
 */
export async function probeTab(
  contents: WebContents,
  input: {
    token: string
    hintToken: string | null
    begin: boolean
    pageOrigin: string
    related: boolean
    allowAction?: (origin: string) => boolean
  },
): Promise<TabProbe> {
  const frames = framesOf(contents)
  const answers = await Promise.all(
    frames.map(async (frame) => ({
      frame,
      report: await askFrame(frame, 'probe', {
        token: input.token,
        hintToken: input.hintToken,
        begin: input.begin,
      }),
    })),
  )
  const reports = answers.filter((one): one is { frame: WebFrameMain; report: LoginReport } =>
    isReport(one.report),
  )
  if (reports.length === 0) return { block: 'no_answer', frame: null, report: null }
  if (reports.some((one) => one.report.hint === 'invalid')) {
    return { block: 'locator_invalid', frame: null, report: null }
  }
  const candidates = reports.filter((one) => one.report.form !== 'none')
  const hinted = candidates.filter((one) => one.report.hint === 'ok')
  const pick = hinted.length === 1 ? hinted[0] : candidates.length === 1 ? candidates[0] : undefined
  if (!pick) {
    return {
      block: candidates.length === 0 ? 'no_form' : 'locator_invalid',
      frame: null,
      report: null,
    }
  }
  let report = pick.report
  if (report.action && input.allowAction) {
    try {
      const target = new URL(report.action)
      if (input.allowAction(target.origin)) report = { ...report, action: null }
    } catch {
      // 解不开的地址照原样预检
    }
  }
  const block = preflight({
    frameOrigin: pick.frame.origin,
    pageOrigin: input.pageOrigin,
    report,
    related: input.related,
  })
  return { block, frame: pick.frame, report: pick.report }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 等提交后的页面落定：主框架换了文档的，等新文档加载完；没换的，等 QUIET_MS 没动静（最多 SETTLE_MS）。
 * 回换没换文档；标签没了回 gone
 */
function settle(contents: WebContents, maxMs = SETTLE_MS): Promise<'navigated' | 'quiet' | 'gone'> {
  return new Promise((resolve) => {
    if (contents.isDestroyed()) return resolve('gone')
    let navigated = false
    let quiet: ReturnType<typeof setTimeout> | undefined
    let cap: ReturnType<typeof setTimeout> | undefined
    const done = (outcome: 'navigated' | 'quiet' | 'gone') => {
      clearTimeout(quiet)
      clearTimeout(cap)
      if (!contents.isDestroyed()) {
        contents.off('did-navigate', onNavigate)
        contents.off('did-navigate-in-page', poke)
        contents.off('did-start-loading', poke)
        contents.off('did-stop-loading', onStop)
        contents.off('destroyed', onGone)
      }
      resolve(outcome)
    }
    const arm = () => {
      clearTimeout(quiet)
      quiet = setTimeout(() => {
        if (!contents.isLoading()) done(navigated ? 'navigated' : 'quiet')
      }, QUIET_MS)
    }
    const poke = () => arm()
    const onNavigate = () => {
      // 换了文档：等它加载完，时限放宽
      navigated = true
      clearTimeout(cap)
      cap = setTimeout(() => done('navigated'), LOAD_MS)
      arm()
    }
    const onStop = () => arm()
    const onGone = () => done('gone')
    contents.on('did-navigate', onNavigate)
    contents.on('did-navigate-in-page', poke)
    contents.on('did-start-loading', poke)
    contents.on('did-stop-loading', onStop)
    contents.once('destroyed', onGone)
    cap = setTimeout(() => done(navigated ? 'navigated' : 'quiet'), maxMs)
    arm()
  })
}

/** 交上去：有按钮提示且在主框架里，对按钮中心真的点一下；不然在框里真的按回车；表单还没交就 requestSubmit 兜底 */
async function submit(
  contents: WebContents,
  frame: WebFrameMain,
  token: string,
  field: 'username' | 'password',
  button: boolean,
): Promise<void> {
  let clicked = false
  if (button && frame === contents.mainFrame) {
    const focused = (await askFrame(frame, 'focus', { token, which: 'submit' })) as {
      ok?: boolean
      point?: { x: number; y: number } | null
    }
    if (focused?.ok && focused.point && !contents.isDestroyed()) {
      const zoom = contents.getZoomFactor()
      const x = Math.round(focused.point.x * zoom)
      const y = Math.round(focused.point.y * zoom)
      contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      clicked = true
    }
  }
  if (!clicked) {
    await askFrame(frame, 'focus', { token, which: field })
    if (contents.isDestroyed()) return
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    contents.sendInputEvent({ type: 'char', keyCode: '\r' })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  }
  await delay(SUBMIT_GRACE_MS)
  // 已经在换页的不用再交；框架这会儿没了也就不回
  if (!contents.isDestroyed() && !contents.isLoading()) {
    await askFrame(frame, 'submit', { token }, 800)
  }
}

/** 填一步：值只送进这一个框架；网页把值改回去的框，聚焦后用真的输入再填 */
async function put(
  contents: WebContents,
  frame: WebFrameMain,
  token: string,
  values: { username?: string; password?: string },
): Promise<boolean> {
  const filled = (await askFrame(frame, 'fill', { token, ...values })) as {
    ok?: boolean
    retype?: unknown
  }
  if (!filled?.ok) return false
  const retype: unknown[] = Array.isArray(filled.retype) ? filled.retype : []
  for (const which of retype) {
    if (which !== 'username' && which !== 'password') continue
    const value = values[which]
    if (value === undefined) continue
    const focused = (await askFrame(frame, 'focus', { token, which })) as { ok?: boolean }
    if (!focused?.ok || contents.isDestroyed()) return false
    contents.insertText(value)
  }
  return true
}

/** 落定后请各框架清框、自检；都回了且都干净才算干净 */
async function scrubTab(
  contents: WebContents,
  probe: SecretProbe,
  since: number,
): Promise<{ clean: boolean; otp: boolean; loginForm: boolean }> {
  const frames = framesOf(contents)
  const results = await Promise.all(
    frames.map((frame) => askFrame(frame, 'scrub', { probe, since })),
  )
  let clean = results.length > 0
  let otp = false
  let loginForm = false
  for (const result of results) {
    const one = result as { clean?: unknown; otp?: unknown; loginForm?: unknown } | undefined
    if (one?.clean !== true) clean = false
    if (one?.otp === true) otp = true
    if (one?.loginForm === true) loginForm = true
  }
  return { clean, otp, loginForm }
}

/** 没有密码时（还没解开就停了）自检用的：什么都找不到 */
const NOTHING: SecretProbe = { length: 0, b1: 1, b2: 1, h1: 0, h2: 0 }

const random = () => randomInt(0, 2 ** 30) / 2 ** 30

/** 开始填之前的预检不过：换成给代理的原因（页面上没有登录框了算页面变了） */
const failureOf = (block: SignInBlock | 'no_answer' | null): FillFailure => {
  switch (block) {
    case 'not_user_visible':
    case 'locator_invalid':
    case 'insecure':
    case 'no_answer':
    case 'unavailable':
    case 'origin_changed':
      return block
    default:
      return 'page_changed'
  }
}

/**
 * 用 entryId 那一条代填这个标签并提交，等落定，清框自检。origin 是条目（卡片）的源，页面的源必须和它完全一样。
 * since：卡片出来的时刻（那之后人在页面里输过字的框也清）
 */
export async function fillTab(input: {
  contents: WebContents
  store: PasswordStore
  entryId: string
  origin: string
  hintToken: string | null
  submitHint: boolean
  related(): boolean
  since: number
}): Promise<FillReport> {
  const { contents, store, entryId, origin, since } = input
  const token = randomUUID()
  let probe = NOTHING
  let submitted = false
  let navigated = false
  const end = async (failure: FillFailure | null, gone = false): Promise<FillReport> => {
    const has = secretFinder(probe)
    if (gone || contents.isDestroyed()) {
      return {
        gone: true,
        submitted,
        failure,
        navigated,
        otp: false,
        loginForm: false,
        clean: false,
        reopenAt: 'about:blank',
      }
    }
    const checked = await scrubTab(contents, probe, since)
    const url = contents.isDestroyed() ? '' : contents.getURL()
    const popup = popupWasTried(contents.id) && !navigated
    return {
      gone: contents.isDestroyed(),
      submitted,
      failure: failure ?? (popup ? 'popup_needed' : null),
      navigated,
      otp: checked.otp,
      loginForm: checked.loginForm,
      clean: checked.clean && !urlHasSecret(url, has),
      reopenAt: reopenUrl(url, has),
    }
  }
  const pageOrigin = () => (contents.isDestroyed() ? '' : contents.mainFrame.origin)
  const look = (hintToken: string | null) =>
    probeTab(contents, {
      token,
      hintToken,
      begin: true,
      pageOrigin: origin,
      related: input.related(),
      allowAction: (target) => store.actionOriginOf(entryId) === target,
    })

  if (pageOrigin() !== origin) return end('origin_changed')
  const first = await look(input.hintToken)
  if (contents.isDestroyed()) return end(null, true)
  if (first.block || !first.frame || !first.report) return end(failureOf(first.block))
  let secret = store.reveal(entryId, origin)
  if (!secret) return end('unavailable')
  probe = secretProbe(secret.password, random)
  const twoStep = first.report.form === 'username'
  const values = twoStep
    ? { username: secret.username }
    : { username: secret.username, password: secret.password }
  secret = null
  const ok = await put(contents, first.frame, token, values)
  if (!ok) return end('page_changed')
  // 先开始等落定再提交：提交引起的换页可能在提交这一步里就完成了
  let landing = settle(contents)
  await submit(contents, first.frame, token, twoStep ? 'username' : 'password', input.submitHint)
  submitted = true
  let landed = await landing
  if (landed === 'gone') return end(null, true)
  if (landed === 'navigated') navigated = true

  if (twoStep) {
    // 两步登录的第二步：等密码框出来，看两次
    const until = Date.now() + STEP_TWO_MS
    let second: TabProbe | null = null
    let sawOtp = false
    for (let look2 = 0; look2 < 2; look2++) {
      if (pageOrigin() !== origin) return end('origin_changed')
      const seen = await look(null)
      if (contents.isDestroyed()) return end(null, true)
      if (seen.report?.form === 'login') {
        second = seen
        break
      }
      if (seen.report?.otp) sawOtp = true
      if (sawOtp || look2 === 1 || Date.now() >= until) break
      landed = await settle(contents, Math.max(until - Date.now(), QUIET_MS))
      if (landed === 'gone') return end(null, true)
      if (landed === 'navigated') navigated = true
    }
    // 没等到密码框：出了验证码的照“要验证”回，别的算页面变了
    if (!second) return end(sawOtp ? null : 'page_changed')
    if (second.block || !second.frame) return end(failureOf(second.block))
    const again = store.reveal(entryId, origin)
    if (!again) return end('unavailable')
    if (!(await put(contents, second.frame, token, { password: again.password }))) {
      return end('page_changed')
    }
    landing = settle(contents)
    await submit(contents, second.frame, token, 'password', false)
    landed = await landing
    if (landed === 'gone') return end(null, true)
    if (landed === 'navigated') navigated = true
  }
  return end(null)
}
