import type {
  ApprovalAnswer,
  ApprovalDecision,
  ApprovalRequest,
  InvocationScope,
} from './runtime.mjs'

export function sameInvocation(a: InvocationScope, b: InvocationScope): boolean {
  return (
    a.hostId === b.hostId &&
    a.deviceId === b.deviceId &&
    a.sessionId === b.sessionId &&
    a.turnId === b.turnId &&
    a.callId === b.callId
  )
}

/** 缺答复、错绑定、过期或取消一律拒绝；本函数不代替宿主的答复来源认证。 */
export function approvalDecision(
  request: ApprovalRequest,
  answer: ApprovalAnswer | null,
  now: number,
  signal: AbortSignal,
): ApprovalDecision {
  if (
    signal.aborted ||
    !Number.isFinite(now) ||
    (request.expiresAt !== null &&
      (!Number.isFinite(request.expiresAt) || now >= request.expiresAt)) ||
    !answer ||
    answer.requestId !== request.id ||
    answer.nonce !== request.nonce ||
    !sameInvocation(request.scope, answer.scope) ||
    !request.choices.includes(answer.decision)
  )
    return 'decline'
  return answer.decision
}
