import type { ClientToolExecutor, ClientToolInvocation } from '../../browser/src/tool-port.mjs'

/** 必须显式指向 Chrome；内置浏览器的拒绝或失败不能触发跨浏览器重试。 */
export function targetsChrome(invocation: ClientToolInvocation): boolean {
  const args = invocation.arguments as Record<string, unknown> | null
  // 只增加内置浏览器的显式句柄分流；旧设备无标识的认领仍按 Chrome 解释。
  if (
    invocation.tool === 'claim' &&
    typeof args?.claimToken === 'string' &&
    args.claimToken.startsWith('builtin:')
  )
    return false
  if (
    ['ensure_claimed', 'release'].includes(invocation.tool) &&
    typeof args?.tabId === 'string' &&
    !args.tabId.startsWith('chrome:')
  )
    return false
  return (
    ['targets', 'claim', 'ensure_claimed', 'release'].includes(invocation.tool) ||
    typeof args?.targetId === 'string' ||
    (typeof args?.tabId === 'string' && args.tabId.startsWith('chrome:')) ||
    (invocation.tool === 'run_actions' &&
      Array.isArray(args?.actions) &&
      args.actions.some(
        (action) =>
          typeof action?.arguments?.tabId === 'string' &&
          action.arguments.tabId.startsWith('chrome:'),
      ))
  )
}

export function createBrowserDispatcher(options: {
  namespace: string
  builtin: ClientToolExecutor
  chrome: ClientToolExecutor
}): ClientToolExecutor {
  return {
    namespace: options.namespace,
    call: (invocation, context) =>
      (targetsChrome(invocation) ? options.chrome : options.builtin).call(invocation, context),
    turnEnded: (turn) => {
      options.builtin.turnEnded?.(turn)
      options.chrome.turnEnded?.(turn)
    },
    phoneAnswer: (answer) => options.builtin.phoneAnswer?.(answer),
  }
}
