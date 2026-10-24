// request_sign_in：代理请人登录。代理不碰密码：不在对话里要、不自己填。
// 浏览器面板（和对话里）出卡片，人选：Litch 用密码库里这个源的账号代填（方案 B）、自己登录、拒绝；手机上也能批。
// 这段时间里代理对这个标签的调用都被拒绝（executor.mts 的 SIGNING_IN）；结果只说是哪一种，不带人输入的任何东西，
// 也不带用户名。真的交接和代填在 passwords/handover.mts。
// 可选的 origin 要和页面的真实源完全一样；usernameRef、passwordRef、submitRef 只当提示：冻结之前经 CDP 给这几个元素
// 加一次性的标记，网页那一侧（passwords/sign-in-page.mts）按标记找，标记必须落在 Litch 认出的登录表单里。
import { randomUUID } from 'node:crypto'
import { signInResult } from '../../../../packages/protocol/src/client-tools-browser.mjs'
import { BadArgs, str } from './args.mjs'
import type { Call, SignInOutcome, Tool } from './executor.mjs'
import type { BrowserPage } from './model.mjs'
import { nodeOf } from './page-ops.mjs'
import { HINT_ATTRIBUTE } from './passwords/fill-rules.mjs'

const MAX_TEXT = 200
const BUSY =
  'A sign-in request for this tab is already waiting for the user. Wait for it to finish; do not request it again.'

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text)

/** 给提示的元素加标记（属性值是口令加角色），网页那一侧取走后去掉 */
const MARK = `function (value) { this.setAttribute(${JSON.stringify(HINT_ATTRIBUTE)}, value) }`

const HINTS = [
  ['usernameRef', 'username'],
  ['passwordRef', 'password'],
  ['submitRef', 'submit'],
] as const

/** 给代理指的元素加标记；一个都没给回 null。编号不认识时抛错（BadArgs） */
async function markHints(call: Call, page: BrowserPage): Promise<string | null> {
  const given = HINTS.filter(([arg]) => str(call.args, arg) !== undefined)
  if (given.length === 0) return null
  const token = randomUUID()
  for (const [arg, role] of given) {
    const backendNodeId = nodeOf(call, page, str(call.args, arg) ?? '')
    const { object } = await page.cdp<{ object: { objectId?: string } }>('DOM.resolveNode', {
      backendNodeId,
    })
    if (!object.objectId) continue
    try {
      await page.cdp('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: MARK,
        arguments: [{ value: `${token}:${role}` }],
      })
    } finally {
      await page.cdp('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {})
    }
  }
  return token
}

/** Litch 代填的结果给代理的话（文字在协议包的 signInResult） */
function filledText(outcome: Extract<SignInOutcome, { kind: 'filled' }>, pageUrl: string): string {
  const by = outcome.preauthorized ? 'grant' : 'user'
  if (outcome.reopened) return signInResult.reopened(pageUrl, outcome.reopened, by)
  const origin = outcome.origin || pageUrl
  const lines = [
    outcome.navigated ? signInResult.filled(origin, by) : signInResult.filledInPlace(origin, by),
  ]
  if (outcome.verification) lines.push(signInResult.needsVerification())
  else if (outcome.stillSignIn) lines.push(signInResult.stillSignIn())
  return lines.join(' ')
}

export const requestSignIn: Tool = async (call) => {
  const page = call.pick()
  const handover = call.handover
  if (!handover) {
    return call.done(
      page,
      'Signing in by the user is not available here. Ask the user to sign in in the Litch browser panel themselves; do not ask for the password.',
    )
  }
  const stop = await call.admitPage(page)
  if (stop) return stop
  // 同一个标签已经交给人了（两次调用前后脚进来）：直接回，不动那一次交接
  if (handover.active(page.id)) return call.done(null, BUSY)
  const reason = clip(str(call.args, 'reason', true).trim())
  const site = clip(str(call.args, 'site')?.trim() || hostOf(page.info().url))
  const origin = originArg(str(call.args, 'origin')?.trim() || null)
  // 冻结之前（CDP 还连着）给提示的元素加标记。没给提示时不让出一拍：前后脚的第二次调用要看得到这一次的冻结
  const hinted = HINTS.some(([arg]) => str(call.args, arg) !== undefined)
  const hintToken = hinted ? await markHints(call, page) : null
  // 等人这段不算调用超时
  const release = call.context.hold?.()
  try {
    const outcome = await handover.request(
      page,
      {
        site,
        reason,
        origin,
        hintToken,
        submitHint: str(call.args, 'submitRef') !== undefined,
        task: call.invocation.task ?? null,
        turnId: call.invocation.turnId,
        ...(call.context.show ? { show: call.context.show } : {}),
      },
      call.context.signal,
    )
    if (outcome === 'busy') return call.done(null, BUSY)
    // 解闸之后快照的对比基准清掉：代理要重新快照
    call.state(page).lastSnapshot = null
    if (typeof outcome === 'object') {
      const next = outcome.reopened ? call.host.page(outcome.reopened) : undefined
      if (next) call.setCurrent(next)
      const shown = next ?? (outcome.reopened ? null : page)
      if (outcome.kind === 'filled') {
        return call.done(shown, filledText(outcome, next?.info().url ?? page.info().url))
      }
      const failed = signInResult.fillFailed(outcome.why)
      return call.done(
        shown,
        outcome.reopened ? `${failed} ${signInResult.movedAfterFailure(outcome.reopened)}` : failed,
      )
    }
    switch (outcome) {
      case 'done':
        return call.done(
          page,
          `The user finished signing in to ${site} and handed the tab back. Take a fresh snapshot before continuing.`,
        )
      case 'cancel':
      case 'declined':
        return call.done(page, signInResult.declined(site))
      case 'origin_changed':
        return call.done(page, signInResult.fillFailed('origin_changed'))
      case 'expired':
        return call.done(page, signInResult.expired())
      case 'closed':
        return call.done(null, `The tab was closed while the user was signing in to ${site}.`)
      case 'failed':
        return call.done(
          null,
          `The tab could not be reloaded safely around the sign-in handover for ${site}, so it was closed. Open the page again in a new tab; ask the user before requesting sign-in again.`,
        )
      default:
        return call.done(null, 'The sign-in request was cancelled.')
    }
  } finally {
    release?.()
  }
}

/** 代理给的源规范成 scheme://host[:port]（带了路径、末尾斜杠的也认）；认不出是参数错 */
function originArg(value: string | null): string | null {
  if (value === null) return null
  try {
    const origin = new URL(value).origin
    if (origin !== 'null') return origin
  } catch {
    // 下面一起报
  }
  throw new BadArgs(`origin must look like "https://example.com": ${value}`)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}
