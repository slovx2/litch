// request_sign_in：代理请人登录。代理不碰密码：不在对话里要、不自己填。
// 浏览器面板（和对话里）出卡片，人选：Litch 用密码库里这个源的账号代填（方案 B）、自己登录、拒绝；手机上也能批。
// 这段时间里代理对这个标签的调用都被拒绝（executor.mts 的 SIGNING_IN）；结果只说是哪一种，不带人输入的任何东西，
// 也不带用户名。真的交接和代填在 passwords/handover.mts。
// 可选的 origin 要和页面的真实源完全一样；usernameRef、passwordRef、submitRef 只当提示：冻结之前经 CDP 给这几个元素
// 加一次性的标记，网页那一侧（passwords/sign-in-page.mts）按标记找，标记必须落在 Litch 认出的登录表单里。
import { randomUUID } from 'node:crypto'
import { str } from './args.mjs'
import type { Call, SignInOutcome, Tool } from './executor.mjs'
import type { BrowserPage } from './model.mjs'
import { nodeOf } from './page-ops.mjs'
import { type FillFailure, HINT_ATTRIBUTE } from './passwords/fill-rules.mjs'

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

/** 代填做不了的原因 → 给代理的话 */
const WHY: Record<FillFailure, string> = {
  origin_changed: 'the page moved to a different origin before Litch could fill it',
  page_changed: 'the page changed and the sign-in form Litch found is gone',
  locator_invalid:
    'Litch could not tell which sign-in form to fill (the refs you gave are not in the sign-in form Litch found, or the page has several)',
  not_user_visible: 'the sign-in fields are not visible to the user',
  insecure:
    'the page is not safe for filling a password (not https, the form sends the password with GET or to another site, or another window is linked to this tab)',
  popup_needed: 'the site signs in through a popup window, which Litch does not open while filling',
  no_answer: 'the page did not respond',
  unavailable: 'the saved passwords could not be read on this computer',
}

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

/** Litch 代填的结果给代理的话 */
function filledText(
  outcome: Extract<SignInOutcome, { kind: 'filled' }>,
  site: string,
  pageUrl: string,
): string {
  const who = outcome.preauthorized
    ? 'the account the user authorized in advance for this task'
    : 'the account the user approved'
  if (outcome.reopened) {
    return `Litch filled ${who} and submitted the sign-in to ${site}, then closed that tab and opened ${pageUrl} in a new tab ${outcome.reopened}. Use the new tab. Take a fresh snapshot to check you are signed in.`
  }
  const lines = [
    `Litch filled ${who} and submitted the sign-in to ${site}; the page loaded ${outcome.origin || pageUrl}.`,
  ]
  if (!outcome.navigated) {
    lines.push('The page did not load a new document; Litch cleared the password fields.')
  }
  if (outcome.verification) {
    lines.push(
      'The site asks for extra verification after the password. Call `request_sign_in` again so the user can finish it.',
    )
  } else if (outcome.stillSignIn) {
    lines.push('The page still shows a sign-in form, so signing in may have failed.')
  }
  lines.push('Take a fresh snapshot to check you are signed in.')
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
  const origin = str(call.args, 'origin')?.trim() || null
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
        return call.done(shown, filledText(outcome, site, next?.info().url ?? page.info().url))
      }
      const moved = outcome.reopened
        ? ` Litch closed that tab and opened the page again in a new tab ${outcome.reopened}; use the new tab.`
        : ''
      return call.done(
        shown,
        `Litch could not sign in to ${site} automatically: ${outcome.why} (${WHY[outcome.why]}).${moved} Call \`request_sign_in\` again so the user can sign in themselves, or ask the user how to proceed.`,
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
        return call.done(
          page,
          `The user declined signing in to ${site}. Do not try another way; ask the user how to proceed.`,
        )
      case 'origin_changed':
        return call.done(
          page,
          `The page is not on ${origin ?? 'the origin you gave'}, so no sign-in was requested. Check the page with \`snapshot\` first.`,
        )
      case 'expired':
        return call.done(page, 'The sign-in request expired before anyone answered.')
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

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}
