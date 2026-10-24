// litch_sessions.options：这台设备上能开子会话的 harness、各自能选的型号（含强度）、缺省型号，和调用者这个会话现在用的。
// 型号一律问各 harness 自己的 model/list（和型号选单同一个来源，不另存一份）：隐藏的不列，所以 Claude Code 没登录、
// 没填密钥的供应商不列，型号 ID 是它报的复合 ID（`<供应商>/<型号>`）、名字是它报的“[供应商] 模型名”。
//
// 也管模型在 start、accept（补 offer 的简报）、wrap_up 的建议里给的 model 的校验（modelFor）：只校验模型这次亲手给的，
// 沿用父会话的、用户从界面给的、别的客户端给的照旧原样交给引擎（Claude 的裸型号按引擎自己的规则归到上一次选的供应商）。
// 认的是：型号选单里有的（不分大小写，换成清单里的写法）；和父会话现在用的一样的（同 harness，老会话的裸型号也算）；
// 不带 `/` 的、清单里恰好一个 `…/<它>`（换成那一个）。别的回 invalid，带上能选的型号。列不出清单（连不上、没有 model/list、
// 清单是空的）时不拦，照原样交给引擎。
import {
  SESSION_TOOL_LIMITS,
  type SessionHarnessOptions,
  type SessionModelOption,
  type SessionsOptionsResult,
} from '../../protocol/src/client-tools-sessions.mjs'
import type { DeviceToolCall } from './device-tools.mjs'
import type { EngineLink } from './engine-link.mjs'
import { parentSettings, StartRefused } from './session-start.mjs'
import type { SessionTree } from './session-tree.mjs'
import { isObject } from './wire.mjs'

/** model/list 里的一行，整理过的 */
export interface CatalogModel {
  /** 交给 thread/start 的 model 的值 */
  id: string
  /** 同一行的另一个标识（codex 的预设 id）；和 id 一样时也照填 */
  alias: string
  name: string
  hidden: boolean
  isDefault: boolean
  efforts: string[]
  defaultEffort: string | null
}

/** model/list 最多翻几页 */
const PAGES = 5
/** 校验失败时提示里最多列几个型号 */
const HINT_MODELS = 12

const textOf = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

function catalogRow(entry: Record<string, unknown>): CatalogModel | null {
  const id = textOf(entry.model) ?? textOf(entry.id)
  if (!id) return null
  const efforts = Array.isArray(entry.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts
        .map((one) => (isObject(one) ? textOf(one.reasoningEffort) : textOf(one)))
        .filter((one): one is string => one !== null)
    : []
  return {
    id,
    alias: textOf(entry.id) ?? id,
    name: textOf(entry.displayName) ?? id,
    hidden: entry.hidden === true,
    isDefault: entry.isDefault === true,
    efforts,
    defaultEffort: textOf(entry.defaultReasoningEffort),
  }
}

/** 一个 harness 的型号清单（含隐藏的，按它报的顺序）。连不上、不支持 model/list 的抛出去 */
export async function modelCatalog(link: EngineLink): Promise<CatalogModel[]> {
  const rows: CatalogModel[] = []
  let cursor: string | null = null
  for (let page = 0; page < PAGES; page++) {
    const result = await link.request('model/list', {
      includeHidden: false,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })
    const data = isObject(result) && Array.isArray(result.data) ? result.data : []
    for (const entry of data) {
      const row = isObject(entry) ? catalogRow(entry) : null
      if (row && !rows.some((one) => one.id === row.id)) rows.push(row)
    }
    cursor = isObject(result) ? textOf(result.nextCursor) : null
    if (!cursor) break
  }
  return rows
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** 选单里看得到的那些 */
const visible = (rows: CatalogModel[]) => rows.filter((row) => !row.hidden)

function option(row: CatalogModel): SessionModelOption {
  return {
    id: row.id,
    name: row.name,
    efforts: row.efforts,
    ...(row.defaultEffort ? { default_effort: row.defaultEffort } : {}),
  }
}

async function harnessOptions(tree: SessionTree, harness: string): Promise<SessionHarnessOptions> {
  let rows: CatalogModel[]
  try {
    rows = visible(await modelCatalog(await tree.link(harness)))
  } catch (error) {
    return { harness, unavailable: messageOf(error), default_model: null, models: [] }
  }
  const max = SESSION_TOOL_LIMITS.optionsModelsMax
  return {
    harness,
    default_model: (rows.find((row) => row.isDefault) ?? rows[0])?.id ?? null,
    models: rows.slice(0, max).map(option),
    ...(rows.length > max ? { truncated: true } : {}),
  }
}

/** 调用者这个会话现在用的型号和强度（thread/resume 报的）。读不出来是 null */
async function currentOf(
  tree: SessionTree,
  call: DeviceToolCall,
): Promise<{ model: string | null; effort: string | null }> {
  try {
    const { config } = await parentSettings(tree, call.threadId, call.harness)
    return { model: textOf(config?.model), effort: textOf(config?.reasoningEffort) }
  } catch {
    return { model: null, effort: null }
  }
}

export async function sessionOptions(
  tree: SessionTree,
  args: Record<string, unknown>,
  call: DeviceToolCall,
): Promise<SessionsOptionsResult> {
  const only = args.harness
  if (only !== undefined && only !== null && typeof only !== 'string')
    throw new StartRefused('invalid', 'harness must be a string.')
  const ids = tree.host.harnesses().map((source) => source.id)
  if (only) checkHarness(tree, only)
  const [current, harnesses] = await Promise.all([
    currentOf(tree, call),
    Promise.all(ids.filter((id) => !only || id === only).map((id) => harnessOptions(tree, id))),
  ])
  return { current: { harness: call.harness, ...current }, harnesses }
}

/** harness 要在这台设备上；不在的话提示有哪些 */
export function checkHarness(tree: SessionTree, harness: string): void {
  const ids = tree.host.harnesses().map((source) => source.id)
  if (!ids.includes(harness))
    throw new StartRefused(
      'invalid',
      `There is no harness "${harness}" on this device. Harnesses here: ${ids.join(', ') || 'none'}. Call litch_sessions.options to see them with their models.`,
    )
}

/** 提示里列的型号：`id (名字)`，最多 HINT_MODELS 个 */
function hint(rows: CatalogModel[]): string {
  const shown = rows
    .slice(0, HINT_MODELS)
    .map((row) => (row.name && row.name !== row.id ? `${row.id} (${row.name})` : row.id))
  const more = rows.length > HINT_MODELS ? `, and ${rows.length - HINT_MODELS} more` : ''
  return `${shown.join(', ')}${more}`
}

/**
 * 模型这次给的 model 在目标 harness 上认不认（规则见文件开头）。认的返回交给引擎的写法，不认抛 invalid。
 * 没给 model 的不用查（缺省照父会话或那边的默认）
 */
export async function modelFor(
  tree: SessionTree,
  call: DeviceToolCall,
  harness: string | undefined,
  model: string | undefined,
): Promise<string | undefined> {
  if (model === undefined || !model.trim()) return model
  const target = harness ?? call.harness
  let rows: CatalogModel[]
  try {
    rows = visible(await modelCatalog(await tree.link(target)))
  } catch {
    return model
  }
  if (rows.length === 0) return model
  const wanted = model.trim()
  const lower = wanted.toLowerCase()
  const exact =
    rows.find((row) => row.id === wanted || row.alias === wanted) ??
    rows.find((row) => row.id.toLowerCase() === lower || row.alias.toLowerCase() === lower)
  if (exact) return exact.id
  if (target === call.harness && (await currentOf(tree, call)).model === wanted) return wanted
  const tails = wanted.includes('/')
    ? []
    : rows.filter((row) => row.id.toLowerCase().endsWith(`/${lower}`))
  if (tails.length === 1) return tails[0]?.id
  const which =
    tails.length > 1
      ? `"${wanted}" matches several models on ${target}: ${hint(tails)}. Pass the full id of the one you mean.`
      : `There is no model "${wanted}" on ${target}. Models there: ${hint(rows)}.`
  throw new StartRefused(
    'invalid',
    `${which} Leave model out to use the default, or call litch_sessions.options to see every harness with its models and efforts, then call again.`,
  )
}
