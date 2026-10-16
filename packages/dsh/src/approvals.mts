import { sleep } from '../../shared/src/util.mjs'
import type { WaterfallOutcome } from './remote.mjs'
import type { DshServer, LiveThread } from './server.mjs'

// dsh 只在模型申请沙箱提权时询问，且只有"允许这一次"与"拒绝"两种裁决。
export async function approve(
  server: DshServer,
  live: LiveThread,
  request: any,
  signal: AbortSignal,
): Promise<WaterfallOutcome> {
  const { projection } = live
  const threadId = projection.thread.id
  // 审批与落盘事件走同一条连接的两条流，等对应的工具条目先到达。
  let call = projection.call(request.callId)
  for (let waited = 0; waited < 2000 && !call && !signal.aborted; waited += 50) {
    await sleep(50)
    call = projection.call(request.callId)
  }
  const reason = request.displayReason?.zh ?? request.reason ?? null
  const itemId = call?.item.id ?? request.callId
  const fileChange = call?.item.type === 'fileChange'
  let decision: unknown
  try {
    // 等裁决的这段时间线程标着在等审批（Projection.waiting）
    const reply = await projection.waiting(
      'approval',
      (method, params) => server.notify(threadId, method, params),
      () =>
        server.call(
          threadId,
          fileChange ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval',
          fileChange
            ? { itemId, startedAtMs: Date.now(), reason, grantRoot: null }
            : {
                itemId,
                startedAtMs: Date.now(),
                approvalId: itemId,
                reason,
                command: call?.item.command ?? String(request.toolName ?? ''),
                cwd: call?.item.cwd ?? projection.thread.cwd,
                commandActions: [],
                additionalPermissions: null,
                proposedExecpolicyAmendment: null,
                proposedNetworkPolicyAmendments: null,
                availableDecisions: ['accept', 'decline', 'cancel'],
              },
          signal,
        ),
    )
    decision = reply?.decision
  } catch {
    // 没有可应答的客户端、请求被撤回或回合已停止，一律按拒绝处理。
    decision = 'decline'
  }
  const allowed = decision === 'accept' || decision === 'acceptForSession'
  if (decision === 'cancel') void server.interrupt(threadId).catch(() => {})
  return { kind: 'result', value: allowed ? 'allowed-once' : 'rejected' }
}
