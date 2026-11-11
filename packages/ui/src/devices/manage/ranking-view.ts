// 模型等级排序页的显示与编辑规则，桌面和手机共用；界面只负责画。
// 设备只存一份从低到高的全局等级（tiers）。“跨 harness 比较等级”关着时，
// 每个 harness 的阶梯是全局等级按 harness 过滤后的投影：同一 harness 内的相对顺序不变，
// 不同 harness 的模型虽然落在同一个全局等级里，也不会被当成互相比较。
import {
  type ModelRankingConfig,
  type ModelRankingSnapshot,
  moveRankedModel,
  type RankedModel,
} from '@litch/core'

export type { RankedModel }

/** 阶梯上的一级。tier 是全局等级的下标，number 是在这条阶梯上从低往高数的第几级 */
export interface RankLevel {
  tier: number
  number: number
  members: RankedModel[]
}

/** 一条阶梯：harness 为 null 时是所有 harness 共用的那条。levels 从高到低排 */
export interface Ladder {
  harness: string | null
  levels: RankLevel[]
}

/** 菜单和键盘能做的调级动作 */
export type RankAction =
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'split' }
  | { kind: 'join'; tier: number }
  | { kind: 'top' }
  | { kind: 'bottom' }
  | { kind: 'unrank' }

/** 拖放的落点：并入某一级，插成新的一级（gap 是插入后它在全局等级里的下标），或放回未分级 */
export type DropTarget =
  | { kind: 'join'; tier: number }
  | { kind: 'gap'; at: number }
  | { kind: 'unranked' }

export const crossHarnessOf = (config: Pick<ModelRankingConfig, 'crossHarness'>): boolean =>
  config.crossHarness === true

const modelOf = (config: ModelRankingConfig, key: string): RankedModel | undefined =>
  config.models.find((model) => model.key === key)

/**
 * 页面上要画的阶梯。开关打开时只有一条；关着时每个有分级模型的 harness 一条，
 * 顺序照 order（设备声明的 harness 顺序），没列在里面的排在后面
 */
export function laddersOf(config: ModelRankingConfig, order: readonly string[] = []): Ladder[] {
  if (crossHarnessOf(config)) return [ladderOf(config, null)]
  const seen = new Set<string>()
  for (const tier of config.tiers)
    for (const key of tier) {
      const model = modelOf(config, key)
      if (model) seen.add(model.harness)
    }
  const harnesses = [
    ...order.filter((id) => seen.has(id)),
    ...[...seen].filter((id) => !order.includes(id)),
  ]
  return harnesses.map((harness) => ladderOf(config, harness))
}

export function ladderOf(config: ModelRankingConfig, harness: string | null): Ladder {
  const levels: RankLevel[] = []
  config.tiers.forEach((tier, index) => {
    const members = tier
      .map((key) => modelOf(config, key))
      .filter((model): model is RankedModel => !!model && (!harness || model.harness === harness))
    if (members.length) levels.push({ tier: index, number: levels.length + 1, members })
  })
  return { harness, levels: levels.reverse() }
}

/** 未分级的模型，按 harness 顺序排；不认识的键（模型清单里没有）不画 */
export function unrankedOf(
  config: ModelRankingConfig,
  order: readonly string[] = [],
): RankedModel[] {
  const rank = (harness: string) => {
    const at = order.indexOf(harness)
    return at < 0 ? order.length : at
  }
  return config.unranked
    .map((key) => modelOf(config, key))
    .filter((model): model is RankedModel => !!model)
    .sort((a, b) => rank(a.harness) - rank(b.harness))
}

/** 一个模型所在的阶梯：开关关着时是它自己 harness 的，开着时是共用的那条 */
export function ladderFor(config: ModelRankingConfig, model: RankedModel): Ladder {
  return ladderOf(config, crossHarnessOf(config) ? null : model.harness)
}

/** 从低到高的那几级，和这个模型在第几级（未分级是 -1） */
function placeOf(config: ModelRankingConfig, key: string) {
  const model = modelOf(config, key)
  const levels = model ? [...ladderFor(config, model).levels].reverse() : []
  const at = levels.findIndex((level) => level.members.some((member) => member.key === key))
  return { levels, at, peers: at < 0 ? 0 : (levels[at]?.members.length ?? 0) }
}

/** 这个动作现在能不能做（不能做的菜单项变灰，键盘按了也不动） */
export function canRank(config: ModelRankingConfig, key: string, action: RankAction): boolean {
  const { levels, at, peers } = placeOf(config, key)
  const ranked = at >= 0
  switch (action.kind) {
    case 'up':
      return ranked && (at < levels.length - 1 || peers > 1)
    case 'down':
      return ranked && (at > 0 || peers > 1)
    case 'split':
      return ranked && peers > 1
    case 'join':
      return levels.some((level, index) => level.tier === action.tier && index !== at)
    case 'top':
      return !ranked || peers > 1 || at < levels.length - 1
    case 'bottom':
      return !ranked || peers > 1 || at > 0
    case 'unrank':
      return ranked
  }
}

/** 动作换成全局等级上的一次移动。做不了的原样返回 */
export function applyRank(
  config: ModelRankingConfig,
  key: string,
  action: RankAction,
): ModelRankingConfig {
  if (!canRank(config, key, action)) return config
  const { levels, at } = placeOf(config, key)
  const here = levels[at]
  const highest = levels.at(-1)
  const lowest = levels[0]
  switch (action.kind) {
    case 'up': {
      const above = levels[at + 1]
      return above
        ? moveRankedModel(config, key, above.tier)
        : moveRankedModel(config, key, (here?.tier ?? 0) + 1, true)
    }
    case 'down': {
      const below = levels[at - 1]
      return below
        ? moveRankedModel(config, key, below.tier)
        : moveRankedModel(config, key, here?.tier ?? 0, true)
    }
    case 'split':
      // 拆出来的放在原来那一级的正上方
      return moveRankedModel(config, key, (here?.tier ?? 0) + 1, true)
    case 'join':
      return moveRankedModel(config, key, action.tier)
    case 'top':
      return moveRankedModel(config, key, highest ? highest.tier + 1 : config.tiers.length, true)
    case 'bottom':
      return moveRankedModel(config, key, lowest ? lowest.tier : 0, true)
    case 'unrank':
      return moveRankedModel(config, key, null)
  }
}

/** 拖放落下。开关关着时只能落在自己 harness 的阶梯上（canDrop 先挡） */
export function applyDrop(
  config: ModelRankingConfig,
  key: string,
  target: DropTarget,
): ModelRankingConfig {
  if (target.kind === 'unranked')
    return config.unranked.includes(key) ? config : moveRankedModel(config, key, null)
  if (target.kind === 'join') return moveRankedModel(config, key, target.tier)
  // 插成新的一级：自己单独一级、插在自己正上方或正下方时位置不变
  const tier = config.tiers.findIndex((members) => members.includes(key))
  if (
    tier >= 0 &&
    config.tiers[tier]?.length === 1 &&
    (target.at === tier || target.at === tier + 1)
  )
    return config
  return moveRankedModel(config, key, target.at, true)
}

/** 拖着的模型能不能落在这条阶梯上 */
export function canDrop(config: ModelRankingConfig, key: string, ladder: Ladder): boolean {
  if (ladder.harness === null) return true
  return modelOf(config, key)?.harness === ladder.harness
}

/** 阶梯上每一级上方那道缝插入时的全局下标；最后一个是最低一级下方 */
export function gapsOf(ladder: Ladder, total: number): number[] {
  const top = ladder.levels[0]
  return [top ? top.tier + 1 : total, ...ladder.levels.map((level) => level.tier)]
}

/** 读取失败的 harness 是怎么回事：界面按它说原因和下一步 */
export type ReadFailure = 'notInstalled' | 'disabled' | 'unavailable' | 'readFailed'

export interface HarnessStateLike {
  id: string
  state: 'ready' | 'unavailable' | 'disabled'
  down: string | null
}

export function readFailureOf(
  harness: string,
  harnesses: readonly HarnessStateLike[],
): ReadFailure {
  const entry = harnesses.find((item) => item.id === harness)
  if (!entry || entry.down === 'notInstalled') return 'notInstalled'
  if (entry.state === 'disabled') return 'disabled'
  if (entry.state === 'unavailable') return 'unavailable'
  return 'readFailed'
}

/** 保存时交给设备的那一份 */
export function writeOf(draft: ModelRankingSnapshot) {
  return {
    expectedRevision: draft.revision,
    crossHarness: crossHarnessOf(draft),
    tiers: draft.tiers,
    unranked: draft.unranked,
    models: draft.models,
    manual: draft.manual ?? [],
  }
}

/** 几个名字连成一句里的一段：中文用顿号，其他用逗号（手机的 JS 引擎不一定有 Intl.ListFormat） */
export const listOf = (items: readonly string[], lang: string): string =>
  items.join(lang.startsWith('zh') ? '、' : ', ')
