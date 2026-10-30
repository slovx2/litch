// 批量只编排现有动作；每一步仍经过同一个执行器和原生安全检查，不重试、不回滚。
import {
  type ClientToolCallResponse,
  clientToolFailure,
} from '../../../../packages/protocol/src/client-tools.mjs'
import {
  COMPUTER_BATCH_ACTION_MS,
  COMPUTER_BATCH_MAX_ACTIONS,
  COMPUTER_BATCH_STATE_MS,
  COMPUTER_TOOL,
} from '../../../../packages/protocol/src/client-tools-computer.mjs'
import type { ClientToolContext, ClientToolInvocation } from '../client-tools/types.mjs'

type Run = (
  call: ClientToolInvocation,
  context: ClientToolContext,
) => Promise<ClientToolCallResponse>
interface Action {
  tool: string
  arguments: Record<string, unknown>
}
const ACTIONS = new Set<string>([
  COMPUTER_TOOL.click,
  COMPUTER_TOOL.typeText,
  COMPUTER_TOOL.pressKey,
  COMPUTER_TOOL.scroll,
  COMPUTER_TOOL.setValue,
  COMPUTER_TOOL.drag,
  COMPUTER_TOOL.selectText,
])
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function message(result: ClientToolCallResponse): string {
  return result.contentItems
    .flatMap((item) => (item.type === 'inputText' ? [item.text] : []))
    .join('\n')
}

// 看护者启动/重连也可能等待；取消结果不等它完成。后续请求仍带同一 signal，不能迟到后再输入。
async function bounded(
  run: Run,
  call: ClientToolInvocation,
  context: ClientToolContext,
): Promise<ClientToolCallResponse> {
  const { signal } = context
  const cancelled = () =>
    clientToolFailure('failed', 'The call was cancelled; the last action may have partly executed.')
  if (signal.aborted) return cancelled()
  let onAbort: () => void = () => {}
  const stopped = new Promise<ClientToolCallResponse>((resolve) => {
    onAbort = () => resolve(cancelled())
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([run(call, context), stopped])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export async function runComputerActions(
  invocation: ClientToolInvocation,
  context: ClientToolContext,
  run: Run,
  // 测试可缩短时限；生产固定用协议中的上限。
  limits = { actionMs: COMPUTER_BATCH_ACTION_MS, stateMs: COMPUTER_BATCH_STATE_MS },
): Promise<ClientToolCallResponse> {
  const args = invocation.arguments
  if (
    !object(args) ||
    Object.keys(args).some((key) => key !== 'actions') ||
    !Array.isArray(args.actions) ||
    args.actions.length < 1 ||
    args.actions.length > COMPUTER_BATCH_MAX_ACTIONS
  ) {
    return clientToolFailure(
      'invalid',
      `actions must contain 1–${COMPUTER_BATCH_MAX_ACTIONS} actions.`,
    )
  }
  // 先验整批的外形，避免第二项写错工具名时第一项已经输入。
  for (const [index, step] of args.actions.entries()) {
    if (
      !object(step) ||
      Object.keys(step).some((key) => key !== 'tool' && key !== 'arguments') ||
      typeof step.tool !== 'string' ||
      !ACTIONS.has(step.tool) ||
      !object(step.arguments) ||
      typeof step.arguments.app !== 'string' ||
      !step.arguments.app.trim()
    ) {
      return clientToolFailure(
        'invalid',
        `Invalid action ${index + 1}. Use an existing action tool and its arguments, including app. Nothing executed.`,
      )
    }
  }
  const actions = args.actions as Action[]
  const summaries: string[] = []
  let last: Action | undefined
  let failure: ClientToolCallResponse | null = null
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), limits.actionMs)
  const signal = AbortSignal.any([context.signal, deadline.signal])
  try {
    for (const [index, step] of actions.entries()) {
      if (signal.aborted) {
        failure = clientToolFailure(
          'failed',
          `Stopped before step ${index + 1}: ${context.signal.aborted ? 'cancelled' : 'batch time limit reached'}.`,
        )
        break
      }
      last = step
      const result = await bounded(
        run,
        {
          ...invocation,
          id: `${invocation.id}/step/${index + 1}`,
          tool: step.tool,
          arguments: step.arguments,
        },
        { ...context, signal },
      )
      if (!result.success || signal.aborted) {
        failure = clientToolFailure(
          'failed',
          `Stopped at step ${index + 1} (${step.tool}): ${deadline.signal.aborted ? 'batch time limit reached; ' : ''}${message(result)}`,
        )
        summaries.push(`${index + 1}. ${step.tool}: failed; may have partly executed.`)
        break
      }
      summaries.push(
        `${index + 1}. ${step.tool}: ${message(result).split('\n')[0]?.slice(0, 240) ?? 'completed'}`,
      )
    }
  } finally {
    clearTimeout(timer)
  }
  // 中间动作已经更新助手的差异基准，所以最后取全文，避免把未送给模型的变化漏掉。
  // 用户取消后不再观察；权限、停止等错误仍由现有观察入口拒绝，不绕检查。
  let state: ClientToolCallResponse | null = null
  if (last && !context.signal.aborted) {
    const observation = new AbortController()
    const stateTimer = setTimeout(() => observation.abort(), limits.stateMs)
    try {
      state = await bounded(
        run,
        {
          ...invocation,
          id: `${invocation.id}/state`,
          tool: COMPUTER_TOOL.getAppState,
          arguments: {
            app: last.arguments.app,
            ...(last.arguments.window === undefined ? {} : { window: last.arguments.window }),
            full: true,
          },
        },
        { ...context, signal: AbortSignal.any([context.signal, observation.signal]) },
      )
    } finally {
      clearTimeout(stateTimer)
    }
  }
  const success = failure === null && state?.success === true
  const detail = [
    failure
      ? message(failure)
      : success
        ? 'Batch completed.'
        : '[litch:failed] Actions completed, but final state could not be read.',
    ...summaries,
    'Only the last attempted app is shown below. Observe other apps separately if needed.',
    ...(success
      ? []
      : [
          'Inspect the state before continuing only unfinished work. Do not replay the batch. On user stop, permission or login prompts, stop and ask the user; on user activity, wait.',
        ]),
    ...(state ? [] : ['Current state unavailable: the call was cancelled or no action started.']),
  ].join('\n')
  return {
    success,
    contentItems: [{ type: 'inputText', text: detail }, ...(state?.contentItems ?? [])],
  }
}
