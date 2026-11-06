// 这是合同消费者，不是真实浏览器执行器；不启动窗口、不读个人配置、不自动批准。
import {
  type ApprovalAnswer,
  type ApprovalRequest,
  approvalDecision,
  type BrowserDriver,
  type BrowserObservation,
  type BrowserOperation,
  type InvocationContext,
  type JsonValue,
  type ToolExecutor,
  type ToolInvocation,
  type ToolResult,
} from '../src/index.mjs'

export function fakeBrowserDriver(): BrowserDriver {
  let current: BrowserObservation = { pageId: 'page', generation: '1', geometryRevision: '1' }
  let frozen = false
  let closed = false
  const check = (operation: BrowserOperation, observation?: BrowserObservation) => {
    operation.signal.throwIfAborted()
    if (frozen || closed) throw new Error('页面不可观察/操作')
    if (observation && JSON.stringify(observation) !== JSON.stringify(current))
      throw new Error('过期观察')
  }
  const unsupported = async (): Promise<never> => {
    throw new Error('示例未实现此能力')
  }
  return {
    capabilities: {
      snapshot: true,
      screenshot: false,
      trustedInput: false,
      evaluate: false,
      upload: false,
      console: false,
      dialogs: false,
      manualSignIn: false,
      credentialFill: false,
    },
    pages: () => [],
    subscribe: () => () => {},
    open: async (_owner, _options, operation) => {
      check(operation)
      return current.pageId
    },
    close: async (_id, operation) => {
      check(operation)
      closed = true
    },
    setKeep: unsupported,
    release: unsupported,
    navigate: async (_id, _url, _timeout, operation) => {
      check(operation)
      current = { ...current, generation: String(Number(current.generation) + 1) }
      return { ok: true }
    },
    history: unsupported,
    snapshot: async (_id, _diff, operation) => {
      check(operation)
      return { observation: current, text: 'fixture', truncated: false }
    },
    screenshot: unsupported,
    act: async (observation, _action, operation) => {
      check(operation, observation)
    },
    evaluate: unsupported,
    console: unsupported,
    wait: unsupported,
    setNavigationGate: () => {},
    freeze: async (_id, operation) => {
      check(operation)
      frozen = true
      return 'fake-handover'
    },
    unfreeze: async (_id, token, operation) => {
      operation.signal.throwIfAborted()
      if (token !== 'fake-handover' || !frozen) throw new Error('交接无效')
      frozen = false
      current = { ...current, generation: String(Number(current.generation) + 1) }
    },
    endSession: async () => {
      closed = true
    },
    flushStorage: async (signal) => {
      signal.throwIfAborted()
    },
    dispose: async () => {
      closed = true
    },
  }
}

/** 用宿主传入的身份、审批和语义驱动完成一次导航，证明不需要 Litch/Electron。 */
export function createFakeExecutor(driver: BrowserDriver, now: () => number): ToolExecutor {
  return {
    definitions: [
      {
        type: 'namespace',
        name: 'example_browser',
        description: '合同示例',
        tools: [
          {
            type: 'function',
            name: 'navigate',
            description: '导航到示例站点',
            inputSchema: {
              type: 'object',
              properties: { url: { type: 'string' } },
              required: ['url'],
              additionalProperties: false,
            },
          },
        ],
      },
    ],
    async execute(call: ToolInvocation, context: InvocationContext): Promise<ToolResult> {
      let mayHaveExecuted = false
      try {
        context.signal.throwIfAborted()
        const args = call.arguments as Record<string, JsonValue> | null
        if (
          call.namespace !== 'example_browser' ||
          call.tool !== 'navigate' ||
          !args ||
          Array.isArray(args) ||
          typeof args.url !== 'string' ||
          Object.keys(args).length !== 1
        )
          throw new Error('参数无效')
        const url = new URL(args.url)
        if (url.protocol !== 'https:') throw new Error('仅支持 HTTPS 示例')
        const request: ApprovalRequest = {
          id: call.scope.callId,
          nonce: `fixture:${call.scope.callId}`,
          scope: call.scope,
          subject: { kind: 'site', origin: url.origin, url: url.href, browser: 'example' },
          choices: ['once', 'decline'],
          expiresAt: now() + 1000,
        }
        const resume = context.hold()
        let answer: ApprovalAnswer | null
        try {
          answer = await context.approvals.request(request, context.signal)
        } finally {
          resume()
        }
        if (approvalDecision(request, answer, now(), context.signal) === 'decline') {
          return {
            success: false,
            content: [],
            error: { code: 'declined', message: '未获批准', mayHaveExecuted: false },
          }
        }
        context.signal.throwIfAborted()
        const operation = { scope: call.scope, signal: context.signal }
        mayHaveExecuted = true
        const page = await driver.open(call.scope, { kind: 'agent', keep: false }, operation)
        const loaded = await driver.navigate(page, url.href, 1000, operation)
        if (!loaded.ok) throw new Error('导航失败')
        const snapshot = await driver.snapshot(page, false, operation)
        return { success: true, content: [{ type: 'text', text: snapshot.text }] }
      } catch {
        return {
          success: false,
          content: [],
          error: { code: 'failed', message: '示例调用失败或已取消', mayHaveExecuted },
        }
      }
    },
    endTurn: async () => {},
    endSession: (scope) => driver.endSession(scope),
    dispose: () => driver.dispose(),
  }
}
