// 型号等级是委派策略，不是性能测试或费用预算。跨 harness 比较仅由独立开关启用。
export const MODEL_RANKING = {
  changed: 'litch/device/modelRanking/changed',
  read: 'litch/device/modelRanking/read',
  write: 'litch/device/modelRanking/write',
  reset: 'litch/device/modelRanking/reset',
} as const
export const MODEL_RANKING_REVISION = '2026-11-11.1'
export interface RankedModel {
  key: string
  harness: string
  model: string
  name: string
  provider?: string
  resolved?: string
  /** 只有引擎原生目录解析的身份才可给别名分档。 */
  trusted?: boolean
  available: boolean
}
export interface ModelRankingConfig {
  schemaVersion: 1
  revision: number
  mode: 'builtin' | 'custom'
  /** 缺省为 false；自定义排序本身不会开启跨 harness 比较。 */
  crossHarness?: boolean
  /** 从低到高；同数组内并级。键是 JSON 编码的 harness、provider、规范型号身份。 */
  tiers: string[][]
  unranked: string[]
  /** 用户主动移动的型号；主动留在未分级的不能被后续自动归类。 */
  manual?: string[]
  models: RankedModel[]
}
export interface ModelRankingSnapshot extends ModelRankingConfig {
  builtinRevision: string
  /** 某引擎读取失败不删旧型号，也不假装该引擎没有型号。 */
  errors: Record<string, string>
}
export interface ModelRankingWrite {
  crossHarness?: boolean
  manual?: string[]
  expectedRevision: number
  tiers: string[][]
  unranked: string[]
  models: RankedModel[]
}

/** 设备 RPC 的 error.data；工具失败也附带同一结构，英文 message 继续保留。 */
export interface ModelLimitFailure {
  litch: 'model_cap_exceeded' | 'model_rank_unknown'
  kind: 'exceeded' | 'unranked'
  parent: RankedModel
  child: RankedModel
  allowed: RankedModel[]
  /** 保留已有调用方使用的字段。 */
  allowedModels: string[]
  parentModel: string | null
  requestedModel: string | null
  mode: ModelRankingConfig['mode']
  crossHarness: boolean
  revision: number
}
export const modelKey = (harness: string, model: string, provider = ''): string =>
  JSON.stringify([harness, provider, model])
export const emptyRanking = (): ModelRankingConfig => ({
  schemaVersion: 1,
  revision: 0,
  mode: 'builtin',
  crossHarness: false,
  tiers: [],
  unranked: [],
  models: [],
})

/** 不对任意网关名称做子串猜测；原生 Claude 精确家族/已知 Codex 系列才自动归类。 */
export function builtinTier(model: RankedModel): number | null {
  const id = model.resolved ?? model.model
  if (model.harness === 'claude-code') {
    if (model.provider && !model.trusted) return null
    const family = id.match(
      /^(?:claude-)?(haiku|sonnet|opus|fable)(?:-\d+(?:-\d+){0,2})?(?:\[1m\])?$/,
    )?.[1]
    return family ? ({ haiku: 0, sonnet: 1, opus: 2, fable: 3 }[family] ?? null) : null
  }
  if (model.harness === 'codex') {
    const family = id.match(/^gpt-(?:5\.6|6(?:\.\d+)?)-(luna|sol|astra)$/)?.[1]
    return family ? ({ luna: 0, sol: 1, astra: 2 }[family] ?? null) : null
  }
  return null
}

function series(model: RankedModel): string | null {
  const tier = builtinTier(model)
  return tier === null ? null : `${model.harness}:${model.provider ?? ''}:${tier}`
}

/** 自定义已保存的相对顺序与并级关系不变；只将新身份放到唯一系列锚点或唯一内置区间。 */
export function mergeRanking(config: ModelRankingConfig, fresh: RankedModel[]): ModelRankingConfig {
  const known = new Map(config.models.map((model) => [model.key, { ...model, available: false }]))
  for (const model of fresh) known.set(model.key, model)
  const models = [...known.values()]
  if (config.mode === 'builtin') {
    const groups = [[], [], [], []] as string[][]
    const unranked: string[] = []
    for (const model of models) {
      const tier = builtinTier(model)
      if (tier === null) unranked.push(model.key)
      else groups[tier]?.push(model.key)
    }
    return { ...config, tiers: groups.filter((group) => group.length), unranked, models }
  }
  const tiers = config.tiers.map((tier) => [...tier])
  const unranked = config.unranked.filter(
    (key) => config.manual?.includes(key) || builtinTier(known.get(key) as RankedModel) === null,
  )
  const assigned = new Set([...tiers.flat(), ...unranked])
  for (const model of models) {
    if (assigned.has(model.key)) continue
    const family = series(model)
    const anchors =
      family === null
        ? []
        : tiers.flatMap((tier, index) =>
            tier.some((key) => {
              const anchor = known.get(key)
              return anchor && series(anchor) === family
            })
              ? [index]
              : [],
          )
    if (anchors.length === 1) tiers[anchors[0] as number]?.push(model.key)
    else if (anchors.length > 1 || builtinTier(model) === null) unranked.push(model.key)
    else {
      const rank = builtinTier(model) as number
      const positions = tiers.map((tier) =>
        tier.map((key) => known.get(key)).map((item) => (item ? builtinTier(item) : null)),
      )
      // 无证据的组、用户反转或混合组都不能作为自动插入区间的依据。
      const candidates = Array.from({ length: tiers.length + 1 }, (_, i) => i).filter((i) =>
        positions.every((ranks, j) =>
          ranks.every((r) => r !== null && (j < i ? r < rank : r > rank)),
        ),
      )
      if (candidates.length === 1) tiers.splice(candidates[0] as number, 0, [model.key])
      else unranked.push(model.key)
    }
    assigned.add(model.key)
  }
  return { ...config, tiers, unranked, models }
}

export function rankingAllows(
  config: ModelRankingConfig,
  parent: RankedModel,
  child: RankedModel,
): boolean {
  if (!config.crossHarness && parent.harness !== child.harness) return true
  // 未提供内置表的引擎保持原委派行为；自定义或显式跨引擎阶梯仍严格比较。
  if (
    !config.crossHarness &&
    config.mode === 'builtin' &&
    !['claude-code', 'codex'].includes(child.harness)
  )
    return true
  if (
    parent.key === child.key &&
    parent.provider === child.provider &&
    parent.resolved === child.resolved
  )
    return true
  if (
    parent.harness === child.harness &&
    parent.provider === child.provider &&
    parent.resolved &&
    parent.resolved === child.resolved
  )
    return true
  const ceiling = modelRank(config, parent),
    target = modelRank(config, child)
  return ceiling !== null && target !== null && target <= ceiling
}

/** 跨 harness 开启后明确使用统一阶梯；builtin 关闭时才使用原生档位。 */
export function modelRank(config: ModelRankingConfig, model: RankedModel): number | null {
  if (config.mode === 'builtin' && !config.crossHarness) return builtinTier(model)
  const index = config.tiers.findIndex((tier) => tier.includes(model.key))
  return index < 0 ? null : index
}

export function modelLimitFailure(
  config: ModelRankingConfig,
  parent: RankedModel,
  child: RankedModel,
  candidates: RankedModel[] = config.models,
  requestedModel: string | null = child.model || null,
): ModelLimitFailure | null {
  if (rankingAllows(config, parent, child)) return null
  const unranked = modelRank(config, parent) === null || modelRank(config, child) === null
  const allowed = candidates.filter(
    (row) => row.available && row.harness === child.harness && rankingAllows(config, parent, row),
  )
  return {
    litch: unranked ? 'model_rank_unknown' : 'model_cap_exceeded',
    kind: unranked ? 'unranked' : 'exceeded',
    parent,
    child,
    allowed,
    allowedModels: allowed.map((row) => row.model),
    parentModel: parent.model || null,
    requestedModel,
    mode: config.mode,
    crossHarness: config.crossHarness === true,
    revision: config.revision,
  }
}

/** 两端共用编辑操作；移动到 null 表示未分级，独立等级插在指定位置。 */
export function moveRankedModel(
  config: ModelRankingConfig,
  key: string,
  target: number | null,
  separate = false,
): ModelRankingConfig {
  const tiers = config.tiers.map((tier) => tier.filter((entry) => entry !== key))
  const unranked = config.unranked.filter((entry) => entry !== key)
  if (target === null) unranked.push(key)
  else if (separate) tiers.splice(Math.max(0, Math.min(target, tiers.length)), 0, [key])
  else (tiers[target] ?? (tiers[target] = [])).push(key)
  return {
    ...config,
    mode: 'custom',
    manual: [...new Set([...(config.manual ?? []), key])],
    tiers: tiers.filter((tier) => tier.length),
    unranked,
  }
}
