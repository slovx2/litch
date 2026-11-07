import type { ClientToolExecutor, ClientToolInvocation } from '../../browser/src/tool-port.mjs'

/** 必须显式指向 Chrome；内置浏览器的拒绝或失败不能触发跨浏览器重试。 */
export function targetsChrome(invocation: ClientToolInvocation): boolean {
  const args = invocation.arguments as Record<string, unknown> | null
  return (
    ['targets', 'claim', 'release'].includes(invocation.tool) ||
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
