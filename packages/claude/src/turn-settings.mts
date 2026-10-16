import { ProtocolError, requiredString } from './protocol-contract.mjs'
import { isSelectableModel } from './server-helpers.mjs'
import { debugLog, isCodexOpenAiModel, resolveClaudeEffort, resolveClaudeModel } from './util.mjs'

export type RuntimeTurnSettings = {
  model?: string
  effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

// 先验证有效设置再发布；客户端附带的摘要偏好和服务层级不阻断模型切换。
export function parseTurnSettings(params: Record<string, unknown>): RuntimeTurnSettings {
  const allowed = new Set([
    'threadId',
    'turnId',
    'model',
    'effort',
    'summary',
    'serviceTier',
    'approvalsReviewer',
  ])
  if (Object.keys(params).some((key) => !allowed.has(key)))
    throw new ProtocolError(-32602, '回合设置包含未知字段')
  if (
    params.summary != null &&
    (typeof params.summary !== 'string' ||
      !['auto', 'concise', 'detailed', 'none'].includes(params.summary))
  )
    throw new ProtocolError(-32602, 'summary格式无效')
  if (params.serviceTier != null && typeof params.serviceTier !== 'string')
    throw new ProtocolError(-32602, 'serviceTier格式无效')
  if (
    params.approvalsReviewer != null &&
    (typeof params.approvalsReviewer !== 'string' ||
      !['user', 'auto_review', 'guardian_subagent'].includes(params.approvalsReviewer))
  )
    throw new ProtocolError(-32602, 'approvalsReviewer格式无效')
  const settings: RuntimeTurnSettings = {}
  if (params.model != null) {
    const model = requiredString(params.model, 'model')
    if (isCodexOpenAiModel(model) || !isSelectableModel(model))
      throw new ProtocolError(-32602, '模型不在当前运行时模型目录中')
    const resolved = resolveClaudeModel(model)
    if (!resolved) throw new ProtocolError(-32602, '不能在运行中清除模型选择')
    settings.model = resolved
  }
  if (params.effort != null) {
    const effort = resolveClaudeEffort(requiredString(params.effort, 'effort'))
    if (!effort) throw new ProtocolError(-32602, '不支持的effort')
    settings.effortLevel = effort
  }
  // 用户明确要求主流程优先：Claude没有同等语义时兼容这些非权限字段，不写入持久配置。
  if (params.summary != null || params.serviceTier != null)
    debugLog('turn.settings.ignored', {
      summary: params.summary ?? null,
      serviceTier: params.serviceTier ?? null,
    })
  // Claude没有自动审查器，保留现有人工审批；不能阻断同一请求中有效的模型设置。
  if (params.approvalsReviewer != null && params.approvalsReviewer !== 'user')
    debugLog('turn.settings.reviewerFallback', { reviewer: 'user' })
  return settings
}
