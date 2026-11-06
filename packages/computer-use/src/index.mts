import { approvalDecision } from '../../automation-contracts/src/approval.mjs'
import type {
  InvocationContext,
  SessionScope,
  ToolExecutor,
  ToolInvocation,
  ToolResult,
  TurnScope,
} from '../../automation-contracts/src/runtime.mjs'
import { createComputerExecutor as createRunner } from './executor.mjs'
import type { HelperAccess } from './executor-shared.mjs'
import { ComputerSelfGuard, type SelfGuardOptions } from './self-guard.mjs'
import { type ComputerToolsOptions, computerTools } from './tools.mjs'
import type { HelperStopped, PermissionStatus } from './wire.mjs'

export type {
  InvocationContext,
  SessionScope,
  ToolInvocation,
  ToolResult,
  TurnScope,
} from '../../automation-contracts/src/runtime.mjs'
export type { HelperAccess, HelperRequester } from './executor-shared.mjs'
export type { ComputerPresentation, ComputerToolsOptions } from './tools.mjs'
export { computerTools } from './tools.mjs'

export interface ComputerUseOptions extends ComputerToolsOptions {
  /** 一个 runtime 只属于一个可信宿主实例。 */
  hostId: string
  helper: HelperAccess
  selfApprovalStorage?: SelfGuardOptions['storage']
  now?(): number
  onInvocation?(call: ToolInvocation, nativeSession: string): void
  /** 由宿主收尾传输；不会寻找其他宿主或路径。 */
  disposeHelper(): Promise<void>
}
const sessionId = (scope: SessionScope) =>
  JSON.stringify([scope.hostId, scope.deviceId, scope.sessionId])
const turnId = (scope: TurnScope) =>
  JSON.stringify([scope.hostId, scope.deviceId, scope.sessionId, scope.turnId])

/** 实际平台和呈现能力必须与宿主提供的 helper 相符。portable 仅用于发布静态工具定义。 */
export function createComputerUse(options: ComputerUseOptions) {
  if (options.platform === 'portable') throw new Error('An executor requires darwin or win32')
  if (!options.hostId || !options.namespace) throw new Error('hostId and namespace are required')
  const guard = new ComputerSelfGuard({
    productName: options.productName,
    ...(options.selfApprovalStorage ? { storage: options.selfApprovalStorage } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  const runner = createRunner({
    helper: options.helper,
    selfGuard: guard,
    platform: options.platform,
    presentation: options,
    ...(options.now ? { now: options.now } : {}),
  })
  const active = new Map<string, Set<{ controller: AbortController; context: InvocationContext }>>()
  const turns = new Map<string, TurnScope>()
  const ended = new Set<string>()
  let disposed = false
  const failure = (message: string): ToolResult => ({
    success: false,
    content: [{ type: 'text', text: message }],
  })
  const executor: ToolExecutor = {
    definitions: [computerTools(options)],
    async execute(call, context) {
      const scope = call.scope
      const turn = turnId(scope)
      if (disposed || ended.has(turn)) return failure('Computer Use scope has ended.')
      if (scope.hostId !== options.hostId || call.namespace !== options.namespace)
        return failure('Computer Use host or namespace does not match.')
      if (!executor.definitions[0]?.tools.some((tool) => tool.name === call.tool))
        return failure(`Unknown tool ${call.tool} in ${options.namespace}.`)
      if (context.signal.aborted) return failure('The call was cancelled.')
      const controller = new AbortController()
      const abort = () => controller.abort()
      context.signal.addEventListener('abort', abort, { once: true })
      const pending = active.get(turn) ?? new Set()
      const item = { controller, context }
      pending.add(item)
      active.set(turn, pending)
      turns.set(turn, scope)
      try {
        const nativeSession = sessionId(scope)
        options.onInvocation?.(call, `${options.hostId}/${nativeSession}`)
        const result = await runner.call(
          {
            id: JSON.stringify([
              scope.hostId,
              scope.deviceId,
              scope.sessionId,
              scope.turnId,
              scope.callId,
            ]),
            callId: scope.callId,
            threadId: nativeSession,
            turnId: scope.turnId,
            device: { id: options.hostId },
            namespace: call.namespace,
            tool: call.tool,
            arguments: call.arguments,
          },
          {
            signal: controller.signal,
            ask: async (ask) => {
              const request = {
                id: ask.id,
                nonce: ask.nonce,
                scope,
                subject: { kind: 'computerSelf' as const, targetId: options.hostId },
                choices: ['once', 'session', 'always', 'decline'] as const,
                expiresAt: null,
              }
              const release = context.hold()
              try {
                const answer = await context.approvals.request(request, controller.signal)
                return approvalDecision(
                  request,
                  answer,
                  options.now?.() ?? Date.now(),
                  controller.signal,
                )
              } finally {
                release()
              }
            },
          },
        )
        return {
          success: result.success,
          content: result.contentItems.map((item) => {
            if (item.type === 'inputText') return { type: 'text' as const, text: item.text }
            const match = /^data:([^;]+);base64,(.*)$/s.exec(item.imageUrl)
            if (!match || match[1] === undefined || match[2] === undefined)
              throw new Error('The helper returned an invalid image')
            return { type: 'image' as const, mimeType: match[1], data: match[2] }
          }),
        }
      } catch (error) {
        return failure(
          controller.signal.aborted
            ? 'The call was cancelled.'
            : `${options.helperName} is not available: ${error instanceof Error ? error.message : String(error)}`,
        )
      } finally {
        context.signal.removeEventListener('abort', abort)
        pending.delete(item)
        if (!pending.size) active.delete(turn)
      }
    },
    async endTurn(scope) {
      if (scope.hostId !== options.hostId) return
      const key = turnId(scope)
      ended.add(key)
      const pending = active.get(key)
      if (pending) for (const item of pending) item.controller.abort()
      await Promise.allSettled(
        [...new Set([...(pending ?? [])].map((item) => item.context.approvals))].map((port) =>
          port.dismiss(scope),
        ),
      )
      const session = sessionId(scope)
      await runner.turnEnded?.({
        deviceId: options.hostId,
        threadId: session,
        turnId: scope.turnId,
      })
      turns.delete(key)
    },
    async endSession(scope) {
      if (scope.hostId !== options.hostId) return
      await Promise.all(
        [...turns.values()]
          .filter((turn) => sessionId(turn) === sessionId(scope))
          .map((turn) => executor.endTurn(turn)),
      )
      guard.endSession(options.hostId, sessionId(scope))
    },
    async dispose() {
      if (disposed) return
      disposed = true
      await Promise.all([...turns.values()].map((scope) => executor.endTurn(scope)))
      guard.dispose()
      await options.disposeHelper()
    },
  }
  return {
    executor,
    stopped(notice: HelperStopped) {
      runner.stopped(notice)
    },
    async permissions(): Promise<PermissionStatus> {
      if (options.platform === 'win32') return { accessibility: true, screenRecording: true }
      return (await (
        await options.helper.client()
      ).request('permissions', {}, 5000)) as PermissionStatus
    },
    async openPermissionSettings(pane: 'accessibility' | 'screenRecording'): Promise<boolean> {
      if (options.platform === 'win32') return false
      return (
        (await (await options.helper.client()).request('openSettings', { pane }, 5000)) as {
          opened: boolean
        }
      ).opened
    },
    restartHelper: () => options.helper.restart(),
    dispose: () => executor.dispose(),
    selfGuard: guard,
  }
}
export const createComputerExecutor = (options: ComputerUseOptions): ToolExecutor =>
  createComputerUse(options).executor
