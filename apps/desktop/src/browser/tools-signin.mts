// request_sign_in：把代理的标签交给人登录。代理不碰密码：不在对话里要、不自己填。
// 交出去的这段时间里代理对这个标签的调用都被拒绝（executor.mts 的 SIGNING_IN），浏览器面板上出卡片等人，
// 人交还或取消之后才回；结果只说是哪一种，不带人输入的任何东西。真的交接在 passwords/handover.mts。
import { str } from './args.mjs'
import type { Tool } from './executor.mjs'

const MAX_TEXT = 200

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text)

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
  const reason = clip(str(call.args, 'reason', true).trim())
  const site = clip(str(call.args, 'site')?.trim() || hostOf(page.info().url))
  // 等人这段不算调用超时
  const release = call.context.hold?.()
  try {
    const outcome = await handover.request(page, { site, reason }, call.context.signal)
    const state = call.state(page)
    state.lastSnapshot = null
    switch (outcome) {
      case 'done':
        return call.done(
          page,
          `The user finished signing in to ${site} and handed the tab back. Take a fresh snapshot before continuing.`,
        )
      case 'cancel':
        return call.done(
          page,
          `The user cancelled signing in to ${site}. Do not try to sign in another way; ask the user how to proceed.`,
        )
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
