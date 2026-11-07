// 批量只编排单步执行器，不另建输入通道；审批、租约和文档检查仍在每一步执行。
import { randomUUID } from 'node:crypto'
import {
  BROWSER_BATCH_MAX_ACTIONS,
  BROWSER_BATCH_TOOLS,
} from '../../../automation-contracts/src/litch/client-tools-browser.mjs'
import type { ClientToolContext, ClientToolExecutor, ClientToolInvocation } from '../tool-port.mjs'
import { type ClientToolCallResponse, clientToolFailure } from '../tool-port.mjs'

interface Action {
  tool: string
  arguments: Record<string, unknown>
}

export async function runBrowserActions(
  invocation: ClientToolInvocation,
  context: ClientToolContext,
  call: ClientToolExecutor['call'],
  chrome: boolean,
  before?: (action: Action) => ClientToolCallResponse | null,
): Promise<ClientToolCallResponse> {
  const input = invocation.arguments as { actions?: unknown } | null
  if (
    !input ||
    !Array.isArray(input.actions) ||
    input.actions.length < 1 ||
    input.actions.length > BROWSER_BATCH_MAX_ACTIONS
  )
    return clientToolFailure('invalid', 'actions must contain 1–12 known browser actions.')
  const actions: Action[] = []
  for (const raw of input.actions) {
    if (
      !raw ||
      typeof raw !== 'object' ||
      !(BROWSER_BATCH_TOOLS as readonly string[]).includes(raw.tool) ||
      !raw.arguments ||
      typeof raw.arguments !== 'object' ||
      Array.isArray(raw.arguments)
    )
      return clientToolFailure(
        'invalid',
        'Use {tool, arguments} with a supported action; nested batches are not allowed.',
      )
    const args = raw.arguments as Record<string, unknown>
    if (
      typeof args.tabId !== 'string' ||
      !args.tabId ||
      args.tabId.startsWith('chrome:') !== chrome ||
      args.newTab === true ||
      args.targetId !== undefined
    )
      return clientToolFailure(
        'invalid',
        'Each action needs an existing tabId from the same browser. Open or claim tabs before batching.',
      )
    actions.push({ tool: raw.tool, arguments: args })
  }
  const controller = new AbortController()
  const aborted = () => controller.abort(context.signal.reason)
  context.signal.addEventListener('abort', aborted, { once: true })
  if (context.signal.aborted) aborted()
  const timeout = setTimeout(
    () => controller.abort(new Error('Browser batch exceeded 60 seconds.')),
    60_000,
  )
  const results: Array<{
    step: number
    tool: string
    success: boolean
    text: string
    elapsedMs: number
    mayHaveExecuted: boolean
    dispatch?: string
    observation?: string
  }> = []
  let last: Action | undefined
  let snapshot: ClientToolCallResponse | null = null
  const prefix = randomUUID()
  const invoke = (
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    suffix: string,
  ) => {
    if (signal.aborted)
      return Promise.resolve(
        clientToolFailure('failed', 'The browser batch was cancelled or timed out.'),
      )
    const work = call(
      { ...invocation, tool, arguments: args, callId: `${prefix}:${suffix}`, browserBatch: true },
      { ...context, signal },
    )
    let cancel: () => void = () => {}
    const stopped = new Promise<ClientToolCallResponse>((resolve) => {
      cancel = () =>
        resolve(
          clientToolFailure(
            'failed',
            'The browser batch was cancelled or timed out. A dispatched action may have executed.',
          ),
        )
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
    })
    return Promise.race([work, stopped]).finally(() => signal.removeEventListener('abort', cancel))
  }
  try {
    for (const action of actions) {
      if (controller.signal.aborted) break
      last = action
      const started = Date.now()
      const preflight = before?.(action)
      const result =
        preflight ??
        (await invoke(action.tool, action.arguments, controller.signal, String(results.length)))
      const receipt = result.contentItems.flatMap((item) => {
        if (item.type !== 'inputText') return []
        try {
          const parsed = JSON.parse(item.text)
          return parsed.inputReceipt ? [parsed.inputReceipt] : []
        } catch {
          return []
        }
      })[0]
      results.push({
        step: results.length + 1,
        tool: action.tool,
        success: result.success,
        elapsedMs: Date.now() - started,
        mayHaveExecuted:
          receipt?.mayHaveExecuted ??
          (preflight == null &&
            ['click', 'type', 'press', 'scroll', 'navigate', 'dialog'].includes(action.tool)),
        ...(receipt ? { dispatch: receipt.dispatch, observation: receipt.observation } : {}),
        text: result.contentItems
          .filter((item) => item.type === 'inputText')
          .map((item) => item.text)
          .join('\n')
          .slice(0, 1600),
      })
      if (!result.success || controller.signal.aborted) break
    }
    clearTimeout(timeout)
    // 最终观察也走普通执行入口；租约失效或登录冻结时只回观察失败，不绕过保护。
    if (last && !context.signal.aborted) {
      const final = new AbortController()
      const cancel = () => final.abort(context.signal.reason)
      context.signal.addEventListener('abort', cancel, { once: true })
      const timer = setTimeout(() => final.abort(), 10_000)
      try {
        snapshot = await invoke(
          'snapshot',
          { tabId: last.arguments.tabId },
          final.signal,
          'snapshot',
        )
      } finally {
        clearTimeout(timer)
        context.signal.removeEventListener('abort', cancel)
      }
    }
    const completed = results.filter((result) => result.success).length
    const success =
      completed === actions.length && !controller.signal.aborted && snapshot?.success === true
    const actionsCompleted = completed === actions.length && !controller.signal.aborted
    return {
      success,
      contentItems: [
        {
          type: 'inputText',
          text: JSON.stringify({
            steps: results,
            completed,
            total: actions.length,
            stopped: !actionsCompleted,
            actionsStatus: actionsCompleted
              ? 'completed'
              : controller.signal.aborted
                ? 'cancelled'
                : 'stopped',
            observationStatus: snapshot
              ? snapshot.success
                ? 'completed'
                : 'failed'
              : 'notAttempted',
            firstFailedStep: results.find((step) => !step.success)?.step ?? null,
            mayHaveExecuted: results.some((step) => step.mayHaveExecuted),
            businessOutcome: 'unknown',
            cancelled: controller.signal.aborted,
            note: actionsCompleted
              ? snapshot?.success
                ? 'All steps returned. Input dispatch and observed changes are reported separately; business outcomes are not verified.'
                : 'All action steps returned; only the final observation failed. Do not repeat completed inputs. Take a fresh snapshot.'
              : 'Stopped without rollback. A failed action may have partly executed; continue only unfinished work.',
          }),
        },
        { type: 'inputText', text: 'Final snapshot:' },
        ...(snapshot?.contentItems ?? [
          {
            type: 'inputText' as const,
            text: 'Not observed: the batch was cancelled before a safe final observation.',
          },
        ]),
      ],
    }
  } finally {
    clearTimeout(timeout)
    context.signal.removeEventListener('abort', aborted)
  }
}
