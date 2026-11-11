// 所有 Litch 子会话的最终校验。目录只说明可用性，等级来自内置规则或用户保存的设备配置。
import {
  emptyRanking,
  MODEL_RANKING,
  MODEL_RANKING_REVISION,
  type ModelRankingConfig,
  type ModelRankingSnapshot,
  mergeRanking,
  modelKey,
  modelLimitFailure,
  type RankedModel,
  rankingAllows,
} from '../../protocol/src/model-ranking.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import type { ControlChannel } from './control.mjs'
import { type CatalogModel, modelCatalog } from './session-options.mjs'
import type { SessionTree } from './session-tree.mjs'
import { isObject } from './wire.mjs'

export function rankedModel(harness: string, model: string, row?: CatalogModel): RankedModel {
  const id = row?.id ?? model
  const provider = row?.identity?.provider ?? (harness === 'claude-code' ? 'unknown' : '')
  const canonical =
    row?.identity?.resolved ??
    (provider && id.startsWith(provider + '/') ? id.slice(provider.length + 1) : id)
  return {
    key: modelKey(harness, canonical, provider),
    harness,
    model: id,
    name: row?.name ?? model,
    available: Boolean(row && !row.hidden),
    ...(provider ? { provider } : {}),
    ...(row?.identity?.resolved ? { resolved: row.identity.resolved } : {}),
    trusted: row?.identity?.trusted === true,
  }
}
export function resolveRankedModel(
  harness: string,
  selected: string | null,
  rows: CatalogModel[],
): RankedModel {
  const exact = selected
    ? rows.find((item) => item.id === selected || item.alias === selected)
    : rows.find((item) => item.isDefault)
  const tails =
    selected && !selected.includes('/')
      ? rows.filter((item) => item.id.endsWith('/' + selected))
      : []
  const row = exact ?? (tails.length === 1 ? tails[0] : undefined)
  return rankedModel(harness, selected ?? row?.id ?? '', row)
}

export class DeviceModelRanking {
  readonly tree: SessionTree
  readonly control: ControlChannel | null
  constructor(tree: SessionTree, control: ControlChannel | null) {
    this.tree = tree
    this.control = control
  }
  async config(): Promise<ModelRankingConfig> {
    // 独立设备夹具没有 Go 控制进程，仍执行内置上限；有控制进程但断线时不能回落放宽。
    return this.control
      ? ((await this.control.request('modelRanking.read', {}, 5000)) as ModelRankingConfig)
      : emptyRanking()
  }
  async read(): Promise<ModelRankingSnapshot> {
    const config = await this.config()
    const errors: Record<string, string> = {}
    const groups = await Promise.all(
      this.tree.host.harnesses().map(async ({ id }) => {
        try {
          return (await modelCatalog(await this.tree.link(id), 50))
            .filter((row) => !row.hidden)
            .map((row) => rankedModel(id, row.id, row))
        } catch (error) {
          errors[id] = error instanceof Error ? error.message : String(error)
          return []
        }
      }),
    )
    let merged = mergeRanking(config, groups.flat())
    // 发现新身份时记在执行设备；离线后不丢位置。冲突只让下次重读，不覆盖用户保存。
    if (
      this.control &&
      (merged.models.some((model) => !config.models.some((old) => old.key === model.key)) ||
        JSON.stringify(merged.tiers) !== JSON.stringify(config.tiers) ||
        JSON.stringify(merged.unranked) !== JSON.stringify(config.unranked))
    ) {
      try {
        merged = (await this.control.request(
          'modelRanking.merge',
          {
            expectedRevision: config.revision,
            crossHarness: config.crossHarness === true,
            manual: merged.manual,
            tiers: merged.tiers,
            unranked: merged.unranked,
            models: merged.models,
          },
          5000,
        )) as ModelRankingConfig
      } catch (error) {
        const current = await this.config()
        if (current.revision === config.revision) throw error
        merged = mergeRanking(current, groups.flat())
      }
    }
    const snapshot = {
      ...merged,
      crossHarness: merged.crossHarness === true,
      builtinRevision: MODEL_RANKING_REVISION,
      errors,
    }
    if (merged.revision !== config.revision)
      this.tree.host.announce(MODEL_RANKING.changed, snapshot, 'modelRanking')
    return snapshot
  }
  async call(method: string, params: unknown): Promise<ModelRankingSnapshot> {
    if (method === MODEL_RANKING.read) return this.read()
    if (!this.control)
      throw new ProtocolError(-32602, 'Device model ranking settings are unavailable')
    if (!isObject(params) || !Number.isSafeInteger(params.expectedRevision))
      throw new ProtocolError(-32602, 'expectedRevision is required')
    if (method !== MODEL_RANKING.write && method !== MODEL_RANKING.reset)
      throw new ProtocolError(-32601, 'Unknown model ranking method')
    // 只接受设备曾看见/本次读到的身份与元数据；客户端只能改位置，不能伪造 trusted 或 resolved。
    const snapshot = await this.read()
    if (snapshot.revision !== params.expectedRevision)
      throw new ProtocolError(-32602, 'Model ranking changed. Reload before saving.')
    if (method === MODEL_RANKING.write) {
      if (params.crossHarness !== undefined && typeof params.crossHarness !== 'boolean')
        throw new ProtocolError(-32602, 'crossHarness must be a boolean')
      if (!Array.isArray(params.tiers) || !Array.isArray(params.unranked))
        throw new ProtocolError(-32602, 'tiers and unranked are required')
      if (params.tiers.some((tier) => !Array.isArray(tier) || tier.length === 0))
        throw new ProtocolError(-32602, 'Each rank must be a nonempty model list')
      const keys = [...params.tiers.flat(), ...params.unranked]
      if (
        keys.length > 10000 ||
        keys.some((key) => typeof key !== 'string') ||
        new Set(keys).size !== keys.length
      )
        throw new ProtocolError(-32602, 'Invalid model placement')
      const known = new Map(snapshot.models.map((row) => [row.key, row]))
      if (keys.some((key) => !known.has(key)))
        throw new ProtocolError(-32602, 'Unknown model identity; reload the catalogue')
      // 保存期间出现的新型号仍保留；用户未看见的项由下一次合并插入，不信任客户端 metadata。
      const chosen = {
        ...snapshot,
        mode: 'custom' as const,
        crossHarness: params.crossHarness === true,
        manual: Array.isArray(params.manual)
          ? params.manual.filter((key): key is string => typeof key === 'string' && known.has(key))
          : (snapshot.manual ?? []),
        tiers: params.tiers as string[][],
        unranked: params.unranked as string[],
        models: keys.map((key) => known.get(key) as RankedModel),
      }
      const merged = mergeRanking(chosen, snapshot.models)
      await this.control.request(
        'modelRanking.write',
        {
          expectedRevision: params.expectedRevision,
          crossHarness: merged.crossHarness === true,
          manual: merged.manual,
          tiers: merged.tiers,
          unranked: merged.unranked,
          models: merged.models,
        },
        5000,
      )
    } else
      await this.control.request(
        'modelRanking.reset',
        { expectedRevision: params.expectedRevision },
        5000,
      )
    const result = await this.read()
    this.tree.host.announce(MODEL_RANKING.changed, result, 'modelRanking')
    return result
  }
}

/** 返回解析后的目标 ID；省略模型时也先解析默认，不能检查空值后交给引擎任意选择。 */
export async function checkChildModel(
  tree: SessionTree,
  parentHarness: string,
  parentModel: string | null,
  harness: string,
  model: string | null,
  userPicked = false,
): Promise<string | null> {
  const config = tree.host.modelRanking ? await tree.host.modelRanking() : emptyRanking()
  if (!config.crossHarness && harness !== parentHarness) return model
  // 未提供内置等级的 harness 保持原行为；显式跨 harness 阶梯不采用此例外。
  if (
    !config.crossHarness &&
    config.mode === 'builtin' &&
    !['claude-code', 'codex'].includes(harness)
  )
    return model
  const read = async (id: string) => {
    try {
      return await modelCatalog(await tree.link(id), 50)
    } catch {
      return []
    }
  }
  const parentRows = await read(parentHarness)
  const targetRows = harness === parentHarness ? parentRows : await read(harness)
  const parent = resolveRankedModel(parentHarness, parentModel, parentRows)
  const child = resolveRankedModel(harness, model, targetRows)
  const effective = mergeRanking(config, [
    ...parentRows.map((row) => rankedModel(parentHarness, row.id, row)),
    ...targetRows.map((row) => rankedModel(harness, row.id, row)),
  ])
  if (userPicked && model && child.available) return child.model
  if (child.model && rankingAllows(effective, parent, child)) return child.model
  const failure = modelLimitFailure(
    effective,
    parent,
    child,
    targetRows.map((row) => rankedModel(harness, row.id, row)),
    model,
  )
  if (!failure) throw new ProtocolError(-32602, 'The requested default model could not be resolved')
  failure.parentModel = parentModel
  const allowed = failure.allowedModels
  if (harness === parentHarness && parentModel && !allowed.includes(parentModel))
    allowed.unshift(parentModel)
  throw Object.assign(
    new ProtocolError(
      -32602,
      `Model exceeds the parent limit or is unranked（超出上限或未分级）: ${parentHarness}/${parentModel ?? 'unknown'} → ${harness}/${model ?? 'default'}. Allowed models: ${allowed.slice(0, 30).join(', ') || 'none'}. Choose an allowed model or inherit the parent.`,
    ),
    {
      data: failure,
    },
  )
}
