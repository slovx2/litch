// session/request_permission 转成 Codex 的审批请求，客户端的决定换回 agent 给的选项。
//
// agent 给的选项按种类对：allow_once ↔ accept（允许这一次），allow_always ↔ acceptForSession（这个会话里都允许，
// 记在 agent 那边），reject_once / reject_always ↔ decline，取消 ↔ cancel（回 agent“取消”，并打断回合）。
// agent 没给的那一种不列在 availableDecisions 里；改文件的审批协议里没有这一项，客户端照固定的四个按钮，
// 只允许缩小放行范围（总是允许可以降为一次），不得把一次接受扩大成永久放行。
import type { LiveThread } from './server.mjs'

const CANCELLED = { outcome: { outcome: 'cancelled' } }

export interface ApprovalHost {
  notify(threadId: string, method: string, params: any): void
  call(threadId: string, method: string, params: any, signal?: AbortSignal): Promise<any>
  interrupt(threadId: string): Promise<void>
}

export async function requestPermission(
  host: ApprovalHost,
  live: LiveThread,
  params: any,
  signal: AbortSignal,
): Promise<unknown> {
  const { projection } = live
  const threadId = projection.thread.id
  const notify = (method: string, value: any) => host.notify(threadId, method, value)
  const options: any[] = Array.isArray(params?.options) ? params.options : []
  const state = projection.active ? projection.ensureTool(params?.toolCall, notify) : undefined
  // 没有在跑的回合、或者请求里没带工具调用：没有可以挂审批的条目，没人能答
  if (!state) return CANCELLED
  // 用户授权只限当前请求；不选 allow_always，避免修改 agent 的持久规则。
  // 缺少一次性允许选项时仍请用户决定，不把更宽的授权冒充成本次允许。
  if (live.agyAutoApprove && !signal.aborted) {
    const once = options.find(
      (entry) =>
        entry?.kind === 'allow_once' &&
        typeof entry.optionId === 'string' &&
        entry.optionId.length > 0,
    )
    if (once) return { outcome: { outcome: 'selected', optionId: once.optionId } }
  }
  const option = (...kinds: string[]) =>
    kinds.flatMap((kind) => options.filter((entry) => entry?.kind === kind))[0]
  const decisions = [
    ...(option('allow_once') ? ['accept'] : []),
    ...(option('allow_always') ? ['acceptForSession'] : []),
    ...(option('reject_once', 'reject_always') ? ['decline'] : []),
    'cancel',
  ]
  const { item } = state
  const fileChange = item.type === 'fileChange'
  const reason = typeof params.toolCall?.title === 'string' ? params.toolCall.title : null
  let decision: unknown
  try {
    const reply = await projection.waiting(notify, () =>
      host.call(
        threadId,
        fileChange ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval',
        fileChange
          ? { itemId: item.id, startedAtMs: Date.now(), reason, grantRoot: null }
          : {
              itemId: item.id,
              startedAtMs: Date.now(),
              approvalId: item.id,
              reason,
              // 不是命令的工具（读文件、联网等）也走命令审批，命令一栏是 agent 给的标题
              command:
                item.type === 'commandExecution' ? item.command : String(reason ?? item.tool ?? ''),
              cwd: item.cwd ?? projection.thread.cwd,
              commandActions: [],
              additionalPermissions: null,
              proposedExecpolicyAmendment: null,
              proposedNetworkPolicyAmendments: null,
              availableDecisions: decisions,
            },
        signal,
      ),
    )
    decision = reply?.decision
  } catch {
    // 没有可应答的客户端、请求被撤回、回合停了：都当取消，命令不跑
    projection.decline(params.toolCall.toolCallId)
    return CANCELLED
  }
  // 没有声明过的对象决定也不接受，避免把带说明的拒绝误当成放行。
  const allowed = decision === 'accept'
  let chosen =
    decision === 'acceptForSession'
      ? option('allow_always', 'allow_once')
      : allowed
        ? option('allow_once')
        : decision === 'decline'
          ? option('reject_once', 'reject_always')
          : undefined
  // ACP 的 always 是“记住选择”，没有限定为当前会话。标准按钮只有 acceptForSession，
  // 不能把这个较窄的同意直接扩大为 agent 的持久策略；明确确认实际选项后才发送。
  if (chosen && ['allow_always', 'reject_always'].includes(chosen.kind)) {
    try {
      const reply = await projection.waiting(
        notify,
        () =>
          host.call(
            threadId,
            'mcpServer/elicitation/request',
            {
              serverName: projection.server,
              turnId: projection.active?.id ?? null,
              mode: 'form',
              _meta: null,
              message: `ACP agent 将记住“${chosen.name ?? chosen.optionId}”。其作用范围由 agent 决定，可能超出当前会话。`,
              requestedSchema: {
                type: 'object',
                properties: {
                  confirm: { type: 'boolean', title: '允许 agent 记住此选择', default: false },
                },
                required: ['confirm'],
              },
            },
            signal,
          ),
        'waitingOnUserInput',
      )
      if (reply?.action !== 'accept' || reply.content?.confirm !== true) chosen = undefined
    } catch {
      chosen = undefined
    }
  }
  if (!chosen || !String(chosen.kind).startsWith('allow'))
    projection.decline(params.toolCall.toolCallId)
  if (!chosen) {
    if (decision === 'cancel') void host.interrupt(threadId).catch(() => {})
    return CANCELLED
  }
  return { outcome: { outcome: 'selected', optionId: chosen.optionId } }
}
