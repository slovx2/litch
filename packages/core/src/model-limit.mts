import {
  type ModelLimitFailure,
  type ModelRankingConfig,
  modelKey,
  modelLimitFailure,
  type RankedModel,
} from '../../protocol/src/model-ranking.mjs'
import { ChannelError } from './channel/protocol.mjs'
import type { ModelLimitFailureView, ModelLimitPreview } from './model-manage.mjs'
import { phrase } from './phrase.mjs'

export interface ModelLimitContext {
  deviceId: string
  /** 父会话。经理的默认委派设置属于该会话。 */
  sessionId: string
  /** 仅经理父会话拥有默认委派模型设置。 */
  isManager?: boolean
}

/** 用设备给的身份元数据查找选择项；不存在时保持未分级，不猜供应商身份。 */
export function rankedModelSelection(
  config: ModelRankingConfig,
  harness: string,
  selected: string | null,
): RankedModel {
  const rows = config.models.filter((row) => row.harness === harness)
  const exact = rows.find((row) => row.model === selected)
  // 目录带供应商前缀时允许唯一尾名；多个供应商同名不能猜是哪一个。
  const tails =
    selected && !selected.includes('/')
      ? rows.filter((row) => row.resolved === selected || row.model.endsWith('/' + selected))
      : []
  const found = exact ?? (tails.length === 1 ? tails[0] : undefined)
  if (found) return found
  return {
    key: modelKey(harness, selected ?? '', harness === 'claude-code' ? 'unknown' : ''),
    harness,
    model: selected ?? '',
    name: selected ?? '',
    available: false,
    ...(harness === 'claude-code' ? { provider: 'unknown', trusted: false } : {}),
  }
}

export function modelLimitView(
  reason: ModelLimitFailure,
  context?: ModelLimitContext,
): ModelLimitFailureView {
  return {
    reason,
    text: phrase(
      reason.kind === 'exceeded' ? 'modelRanking.limitExceeded' : 'modelRanking.limitUnranked',
      {
        parent: reason.parent.name || reason.parent.model,
        child: reason.child.name || reason.child.model,
      },
    ),
    settings: context
      ? [
          ...(context.isManager
            ? [
                {
                  kind: 'manager-default-model' as const,
                  deviceId: context.deviceId,
                  sessionId: context.sessionId,
                },
              ]
            : []),
          { kind: 'model-ranking', deviceId: context.deviceId },
        ]
      : [],
  }
}

/** 经理默认型号可即时预检；排名快照和父/子身份使用两端已订阅的数据，不另维护比较算法。 */
export function modelLimitPreview(
  config: ModelRankingConfig,
  parent: RankedModel,
  child: RankedModel,
  context: ModelLimitContext,
): ModelLimitPreview {
  const reason = modelLimitFailure(config, parent, child)
  return { allowed: reason === null, failure: reason ? modelLimitView(reason, context) : null }
}

export function modelLimitSettings(error: ChannelError, context: ModelLimitContext): ChannelError {
  if (!error.modelLimit) return error
  const modelLimit = modelLimitView(error.modelLimit.reason, context)
  return new ChannelError(error.code, error.message, modelLimit.text, { modelLimit })
}

/** 只认新合同的完整原因，不根据英文错误猜父/子身份。 */
export function isModelLimitFailure(raw: unknown): raw is ModelLimitFailure {
  if (!raw || typeof raw !== 'object') return false
  const value = raw as Partial<ModelLimitFailure>
  const model = (row: unknown): row is RankedModel => {
    if (!row || typeof row !== 'object') return false
    const m = row as Partial<RankedModel>
    return (
      ['key', 'harness', 'model', 'name'].every(
        (key) => typeof m[key as keyof RankedModel] === 'string',
      ) && typeof m.available === 'boolean'
    )
  }
  return (
    ((value.litch === 'model_cap_exceeded' && value.kind === 'exceeded') ||
      (value.litch === 'model_rank_unknown' && value.kind === 'unranked')) &&
    model(value.parent) &&
    model(value.child) &&
    Array.isArray(value.allowed) &&
    value.allowed.every(model) &&
    Array.isArray(value.allowedModels) &&
    value.allowedModels.every((id) => typeof id === 'string') &&
    (value.parentModel === null || typeof value.parentModel === 'string') &&
    (value.requestedModel === null || typeof value.requestedModel === 'string') &&
    (value.mode === 'builtin' || value.mode === 'custom') &&
    typeof value.crossHarness === 'boolean' &&
    Number.isSafeInteger(value.revision)
  )
}
