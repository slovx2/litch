// 登录只交给用户手动完成。旧的元素提示字段被忽略，不再触发代理代填。
import { signInResult } from '../../../automation-contracts/src/litch/client-tools-browser.mjs'
import { BadArgs, str } from './args.mjs'
import type { Tool } from './executor.mjs'

const MAX_TEXT = 200
const BUSY = 'A sign-in request for this tab is already waiting for the user.'
const clip = (text: string) => text.slice(0, MAX_TEXT)

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
  // 等人这段不算调用超时
  const release = call.context.hold?.()
  try {
    const outcome = await handover.request(
      page,
      {
        site,
        reason,
        origin,
        hintToken: null,
        submitHint: false,
        task: call.invocation.task ?? null,
        turnId: call.invocation.turnId,
        ...(call.context.show ? { show: call.context.show } : {}),
      },
      call.context.signal,
    )
    if (outcome === 'busy') return call.done(null, BUSY)
    // 解闸之后快照的对比基准清掉：代理要重新快照
    call.state(page).lastSnapshot = null
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
        return call.done(page, signInResult.originChanged())
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
