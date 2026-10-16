// 与固定的 Codex 0.157.1 AskForApproval wire schema 一致。
export const approvalFlows = [
  'sandbox_approval',
  'rules',
  'skill_approval',
  'request_permissions',
  'mcp_elicitations',
] as const

export type ApprovalFlow = (typeof approvalFlows)[number]
export type ApprovalPolicy =
  | 'untrusted'
  | 'on-request'
  | 'never'
  | { granular: Record<ApprovalFlow, boolean> }

export function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  if (typeof value === 'string') return ['untrusted', 'on-request', 'never'].includes(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (Object.keys(value).length !== 1 || !('granular' in value)) return false
  const granular = value.granular
  return (
    !!granular &&
    typeof granular === 'object' &&
    !Array.isArray(granular) &&
    Object.keys(granular).length === approvalFlows.length &&
    approvalFlows.every((key) => typeof (granular as Record<string, unknown>)[key] === 'boolean')
  )
}

export function normalizeApprovalPolicy(value: unknown): ApprovalPolicy | null {
  return isApprovalPolicy(value) ? value : null
}

// 开关表示是否允许向用户发起这类审批，false 是拒绝，不是自动授权。
export function allowsApproval(policy: ApprovalPolicy | null, flow: ApprovalFlow): boolean {
  if (policy === 'never') return false
  return typeof policy === 'object' && policy !== null ? policy.granular[flow] : true
}

export function toolApprovalFlow(name: string): ApprovalFlow {
  if (name === 'Bash') return 'sandbox_approval'
  if (name === 'Skill') return 'skill_approval'
  if (
    name === 'RequestPermissions' ||
    name === 'mcp__codex_harness_adapter_permissions__request_permissions'
  )
    return 'request_permissions'
  return 'rules'
}
