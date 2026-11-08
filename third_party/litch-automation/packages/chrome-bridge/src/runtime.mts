import { randomUUID } from 'node:crypto'
import { approvalDecision } from '../../automation-contracts/src/approval.mjs'
import type {
  ApprovalAnswer,
  ApprovalPort,
  ApprovalRequest,
  FileAccess,
  InvocationScope,
  SessionScope,
  ToolExecutor,
  ToolResult,
  TurnScope,
} from '../../automation-contracts/src/runtime.mjs'
import { ChromeExecutor, type ChromeExecutorOptions } from './executor.mjs'
import { chromeToolsSpec } from './tool-definitions.mjs'

export interface ChromeRuntimeOptions extends Omit<ChromeExecutorOptions, 'allowed'> {
  hostId: string
  /** 运行浏览器的本机设备；来源和租户的访问控制由 allowed 决定。 */
  allowed(scope: InvocationScope): boolean
  /** 没有文件授权端口时不开放 upload。 */
  files?: FileAccess
}
const turnKey = (scope: TurnScope): string =>
  JSON.stringify([scope.hostId, scope.deviceId, scope.sessionId, scope.turnId])
const threadKey = (scope: SessionScope): string => JSON.stringify([scope.hostId, scope.sessionId])
const failure = (code: string, message: string, mayHaveExecuted = false): ToolResult => ({
  success: false,
  content: [{ type: 'text', text: message }],
  error: { code, message, mayHaveExecuted },
})

async function answerOrCancelled(
  work: Promise<ApprovalAnswer | null>,
  signal: AbortSignal,
): Promise<ApprovalAnswer | null> {
  let off = () => {}
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        const abort = () => resolve(null)
        signal.addEventListener('abort', abort, { once: true })
        off = () => signal.removeEventListener('abort', abort)
        if (signal.aborted) abort()
      }),
    ])
  } finally {
    off()
  }
}

/** 绑定可信 scope 的 SDK 入口；不要求 Litch 会话/设备对象。 */
export function createChromeExecutor(options: ChromeRuntimeOptions): ToolExecutor {
  const executor = new ChromeExecutor({ ...options, allowed: () => true })
  const spec = chromeToolsSpec(options.namespace, options.productName)
  if (!options.files) spec.tools = spec.tools.filter((tool) => tool.name !== 'upload')
  const tools = new Set(spec.tools.map((tool) => tool.name))
  const pending = new Map<
    string,
    { scope: InvocationScope; abort: AbortController; done: Promise<ToolResult> }
  >()
  const turns = new Map<string, { scope: TurnScope; approvals: Set<ApprovalPort> }>()
  const ended = new Set<string>()
  const endedSessions = new Set<string>()
  let disposed = false

  async function finish(scope: TurnScope): Promise<void> {
    const key = turnKey(scope)
    ended.add(key)
    const calls = [...pending.values()].filter((call) => turnKey(call.scope) === key)
    for (const call of calls) call.abort.abort()
    const turn = turns.get(key)
    await Promise.allSettled([...(turn?.approvals ?? [])].map((port) => port.dismiss(scope)))
    await Promise.allSettled(calls.map((call) => call.done))
    await Promise.all(
      [...executor.pages.values()]
        .filter(
          (page) =>
            page.grant.owner.deviceId === scope.deviceId &&
            page.grant.owner.threadId === threadKey(scope) &&
            page.grant.owner.turnId === scope.turnId,
        )
        .map((page) =>
          page.release(!page.grant.original && !page.grant.keep).catch(() => {
            page.valid = false
          }),
        ),
    )
    executor.turnEnded({
      deviceId: scope.deviceId,
      threadId: threadKey(scope),
      turnId: scope.turnId,
    })
    turns.delete(key)
  }
  return {
    definitions: [spec],
    async execute(call, context) {
      if (
        disposed ||
        call.scope.hostId !== options.hostId ||
        ended.has(turnKey(call.scope)) ||
        endedSessions.has(JSON.stringify([call.scope.deviceId, threadKey(call.scope)]))
      )
        return failure('scopeUnavailable', 'This host, session or turn is no longer available.')
      if (context.signal.aborted) return failure('cancelled', 'The call was cancelled.')
      if (call.namespace !== options.namespace || !tools.has(call.tool))
        return failure('invalid', 'Unknown Chrome tool.')
      try {
        if (!options.allowed(call.scope))
          return failure('denied', 'Chrome access is not permitted for this scope.')
      } catch {
        return failure('denied', 'Chrome access policy could not authorize this scope.')
      }
      const scope = Object.freeze({ ...call.scope })
      const key = turnKey(scope)
      const turn = turns.get(key) ?? { scope, approvals: new Set<ApprovalPort>() }
      turn.approvals.add(context.approvals)
      turns.set(key, turn)
      const id = randomUUID()
      const abort = new AbortController()
      const signal = AbortSignal.any([context.signal, abort.signal])
      const done = (async (): Promise<ToolResult> => {
        let args = call.arguments
        if (call.tool === 'upload') {
          const value = args as { paths?: unknown }
          if (
            !value ||
            !Array.isArray(value.paths) ||
            !value.paths.every((path) => typeof path === 'string')
          )
            return failure('invalid', 'Upload requires local file paths.')
          args = {
            ...value,
            paths: [...(await options.files!.authorizeUpload(value.paths, scope, signal))],
          }
        }
        const response = await executor.call(
          {
            id,
            device: { id: scope.deviceId, name: options.productName, kind: 'local', target: null },
            threadId: threadKey(scope),
            turnId: scope.turnId,
            callId: scope.callId,
            namespace: call.namespace,
            tool: call.tool,
            arguments: args,
            harness: null,
            cwd: null,
          },
          {
            signal,
            hold: () => context.hold(),
            ask: async (ask) => {
              const subject: ApprovalRequest['subject'] =
                ask.kind === 'site'
                  ? { kind: 'site', origin: ask.origin, url: ask.url, browser: 'chrome' }
                  : ask.kind === 'chromeInstance'
                    ? { kind: 'browserInstance', instanceId: ask.instanceId, name: ask.name }
                    : {
                        kind: 'action',
                        description:
                          ask.kind === 'chromeTab'
                            ? `Control Chrome tab ${ask.title} at ${ask.url}`
                            : ask.kind === 'chromeSignIn'
                              ? `Sign in manually at ${ask.origin}: ${ask.reason}`
                              : 'Approve Chrome operation',
                      }
              const request: ApprovalRequest = {
                id: randomUUID(),
                nonce: randomUUID(),
                scope,
                subject,
                choices: ['once', 'session', 'always', 'decline'],
                expiresAt: null,
              }
              const resume = context.hold()
              try {
                return approvalDecision(
                  request,
                  await answerOrCancelled(context.approvals.request(request, signal), signal),
                  Date.now(),
                  signal,
                )
              } catch {
                return 'decline'
              } finally {
                resume()
              }
            },
          },
        )
        return {
          success: response.success,
          content: response.contentItems.map((item) => {
            if (item.type === 'inputText') return { type: 'text' as const, text: item.text }
            const match = /^data:([^;,]+);base64,(.*)$/s.exec(item.imageUrl)
            if (!match) throw new Error('Invalid image result')
            return { type: 'image' as const, mimeType: match[1]!, data: match[2]! }
          }),
        }
      })().catch(() =>
        failure(
          'failed',
          'Chrome operation failed. Inspect the current page before retrying.',
          true,
        ),
      )
      pending.set(id, { scope, abort, done })
      try {
        return await done
      } finally {
        pending.delete(id)
      }
    },
    endTurn: finish,
    async endSession(scope) {
      endedSessions.add(JSON.stringify([scope.deviceId, threadKey(scope)]))
      await Promise.all(
        [...turns.values()]
          .filter(
            (turn) =>
              turn.scope.hostId === scope.hostId &&
              turn.scope.deviceId === scope.deviceId &&
              turn.scope.sessionId === scope.sessionId,
          )
          .map((turn) => finish(turn.scope)),
      )
    },
    async dispose() {
      disposed = true
      try {
        await Promise.all([...turns.values()].map((turn) => finish(turn.scope)))
      } finally {
        executor.dispose()
      }
    },
  }
}
