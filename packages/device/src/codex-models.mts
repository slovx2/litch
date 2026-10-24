// 原生 codex 的模型清单（litch/harness/models/read、write）。
// codex 的做法（上游 rust-v0.162.0-alpha.20 的 core/src/config/mod.rs、models-manager；0.160.0 实测）：
//   - config.toml 的 model_catalog_json 是一个 JSON 文件的路径（相对路径按 config.toml 所在目录算），内容是 ModelsResponse
//     （{"models":[ModelInfo…]}，至少一个模型，每个都要有 base_instructions 或 model_messages.instructions_template）；
//   - codex 建配置时读它，读到就整份替换自己的模型目录（StaticModelsManager，不再联网刷新）。模型目录是 app-server 起来时
//     定下的，所以清单改了要重启 codex 才生效（effect harness）。文件读不出来 codex 连配置都建不起来，所以写之前要核对好；
//   - requirements（管理员）里也可以定 model_catalog_json，定了就以它为准。
//
// Litch 管的清单放在 $CODEX_HOME/litch-models.json，config.toml 用户层的 model_catalog_json 指向它。
// 每一项是完整的 ModelInfo：把底稿（base）整个拷过来，只改这几处：
//   - slug（发给模型服务的模型名）、display_name；
//   - 改了上下文时：context_window 换成新值；max_context_window 比新值小时抬到新值（它是全局 model_context_window 能盖到的上限，
//     不抬的话全局设置会被压回底稿的上限）；auto_compact_token_limit 去掉，由 codex 按新窗口的 90% 算
//     （它是照底稿的窗口定的，留着的话窗口改大了还是在旧门槛压缩；codex 用的时候本来也会压到窗口的 90% 以内）；
//   - visibility 一律 list、priority 照清单的顺序：列进清单就是要在选单里出现，按这个顺序排（codex 按 priority 排，
//     只把 visibility 为 list 的放进选单）；
//   - litch_base：底稿是哪个模型（和 slug 不同时才写）。ModelInfo 不拒绝认不出的字段（serde 默认，没有 deny_unknown_fields；
//     0.160.0 实测读得进），所以记在每一项里，不另放文件。
// 别的字段（推理强度、工具、提示词……）原样照底稿，不让改：模型目录的字段很多，这一版只开放名字和上下文。
//
// 底稿是 codex 自带的模型目录（主进程跑 `codex debug models --bundled`，TranslatorContext.bundledCatalog），
// 按 codex 的顺序（priority）只列选单里看得到的（visibility 为 list）；隐藏的（自动审查用的之类）不列，已经被清单用到的照样列。
// 清单文件里有、自带目录里没有的模型（用户自己配的、新版 codex 去掉了的）也补进底稿。
// 原样用一个自带模型的项，写的时候总是照这一版 codex 自带的重新拷，codex 升级之后重写一遍就跟上了。
//
// model_catalog_json 指向的不是 Litch 的文件（用户自己配的）：照样读出来列；写的时候写到 Litch 的文件、改指向，原文件不动。
// 那个文件里自带目录没有的模型就是它们自己的底稿。和自带的同名的，底稿是两份合起来：自带的打底，用户写了的字段盖上去
// （冲突以用户的为准）。用户写的、和自带不一样的那些字段记在每一项的 litch_own 里（以它为底稿的项都记），
// 往后再读 Litch 的文件也照这样合，自带目录升级了跟着变的只有用户没动过的字段。
import { createHash } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import type {
  HarnessModelBase,
  HarnessModelEntry,
  HarnessModelsReadResponse,
  HarnessModelsWriteResponse,
  HarnessText,
} from '../../protocol/src/harness-config.mjs'
import {
  type Ask,
  batchWrite,
  type CodexSnapshot,
  layerTitle,
  overridingLayer,
  readSnapshot,
} from './codex-config-io.mjs'
import { ControlFailure } from './control.mjs'
import { HarnessConfigError, text } from './harness-config.mjs'
import { isObject } from './wire.mjs'

/** Litch 管的清单文件，在 $CODEX_HOME 下 */
export const LITCH_CATALOG = 'litch-models.json'
/** 每一项里记底稿的字段 */
export const BASE_FIELD = 'litch_base'
/** 每一项里记用户自己写的字段（底稿是自带模型、用户又改过的时候） */
export const OWN_FIELD = 'litch_own'
/** 不算用户自己的字段：名字是这一项自己的，顺序和是否列出由清单定，另两个是 Litch 记的 */
const NOT_OWN = new Set(['slug', 'priority', 'visibility', BASE_FIELD, OWN_FIELD])
const KEY = 'model_catalog_json'

type ModelInfo = Record<string, unknown>

export interface ModelsContext {
  ask: Ask
  harness: string
  home: string
  bundledCatalog(): Promise<unknown>
}

interface CatalogState {
  snapshot: CodexSnapshot
  litchPath: string
  /** 现在生效的指向（绝对路径）；没配是 null */
  current: string | null
  /** 用户层写的指向（绝对路径）；没写是 null */
  userPath: string | null
  /** 底稿：模型名 → 完整的 ModelInfo */
  templates: Map<string, ModelInfo>
  /** 底稿是自带模型、用户又改过的：模型名 → 用户自己写的字段 */
  owns: Map<string, ModelInfo>
  bases: HarnessModelBase[]
  entries: HarnessModelEntry[]
  version: string
  notes: HarnessText[]
  readOnlyReason: HarnessText | null
}

const slugOf = (model: ModelInfo): string => (typeof model.slug === 'string' ? model.slug : '')
const numberOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
/** 记在这一项里的底稿；没有记（原样的、用户自己写的）是它自己 */
const baseOf = (model: ModelInfo): string =>
  typeof model[BASE_FIELD] === 'string' && model[BASE_FIELD] ? model[BASE_FIELD] : slugOf(model)

/** 用户的模型里和自带的不一样（或自带没有）的字段 */
function ownFields(mine: ModelInfo, shipped: ModelInfo): ModelInfo {
  return Object.fromEntries(
    Object.entries(mine).filter(
      ([key, value]) => !NOT_OWN.has(key) && !isDeepStrictEqual(value, shipped[key]),
    ),
  )
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** 配置里的路径：requirements 给的是 file: 网址（0.162 起是 PathUri），config.toml 里是路径，相对的按 config.toml 所在目录算 */
function pathOf(value: unknown, configFile: string): string | null {
  if (typeof value !== 'string' || !value) return null
  if (value.startsWith('file:')) {
    try {
      return fileURLToPath(value)
    } catch {
      return null
    }
  }
  return isAbsolute(value) ? value : resolve(dirname(configFile), value)
}

/**
 * 模型目录现在指向哪：requirements 定了的以它为准；比用户层优先的一层（命令行参数、项目、管理员的配置）写了的以那一层为准；
 * 否则是用户层的
 */
function pointing(snapshot: CodexSnapshot) {
  const userPath = pathOf(snapshot.user[KEY], snapshot.file)
  const required = pathOf(snapshot.requirements?.modelCatalogJson, snapshot.file)
  const layer = required ? null : overridingLayer(snapshot, [KEY])
  const current = required ?? (layer ? pathOf(snapshot.config[KEY], snapshot.file) : userPath)
  return { current, userPath, required, layer }
}

/** 读出来的清单：模型的数组；不成样子抛错，错误的话给人看 */
function parseCatalog(content: string): ModelInfo[] {
  const parsed: unknown = JSON.parse(content)
  if (!isObject(parsed) || !Array.isArray(parsed.models))
    throw new Error('not a {"models": [...]} object')
  const models = parsed.models.filter(isObject)
  if (models.some((model) => !slugOf(model))) throw new Error('a model has no slug')
  return models
}

/** codex 自带的目录：全部模型（含隐藏的），问不到的话说为什么 */
async function bundled(
  context: ModelsContext,
): Promise<{ models: ModelInfo[]; note: HarnessText | null }> {
  try {
    const result = await context.bundledCatalog()
    const catalog = isObject(result) ? result.catalog : null
    if (!isObject(catalog) || !Array.isArray(catalog.models))
      throw new Error('no models in the reply')
    return {
      models: catalog.models.filter((model) => isObject(model) && slugOf(model)),
      note: null,
    }
  } catch (error) {
    const said =
      error instanceof ControlFailure
        ? error.detail.text
        : text(
            String((error as Error)?.message ?? error),
            String((error as Error)?.message ?? error),
          )
    return {
      models: [],
      note: text(
        `问不到 codex 自带的模型目录，没有可以照着的模型：${said['zh-CN']}`,
        `Could not get the catalog bundled with codex, so there are no models to base entries on: ${said.en}`,
      ),
    }
  }
}

const hashOf = (...parts: (string | null)[]): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`

/** 版本：config.toml 用户层的版本，加上指向的文件和 Litch 的文件的内容 */
async function versionOf(snapshot: CodexSnapshot, current: string | null, litchPath: string) {
  const [pointed, ours] = await Promise.all([
    current && current !== litchPath ? readText(current) : null,
    readText(litchPath),
  ])
  return hashOf(snapshot.version, current, pointed, ours)
}

function baseInfo(id: string, model: ModelInfo): HarnessModelBase {
  return {
    id,
    displayName:
      typeof model.display_name === 'string' && model.display_name ? model.display_name : id,
    // codex 自己也是先看 context_window，没有再看 max_context_window（ModelInfo::resolved_context_window）
    contextWindow: numberOf(model.context_window) ?? numberOf(model.max_context_window),
    description:
      typeof model.description === 'string' && model.description ? model.description : null,
  }
}

async function readState(context: ModelsContext): Promise<CatalogState> {
  const { ask, harness, home } = context
  const litchPath = join(home, LITCH_CATALOG)
  const [snapshot, shipped] = await Promise.all([readSnapshot(ask, harness), bundled(context)])
  const notes: HarnessText[] = shipped.note ? [shipped.note] : []
  const { current, userPath, required, layer } = pointing(snapshot)
  let readOnlyReason: HarnessText | null = null
  if (required)
    readOnlyReason = text(
      '管理员下发的要求固定了模型目录（model_catalog_json），这里改不了',
      'The model catalog (model_catalog_json) is fixed by managed requirements',
    )
  else if (layer) {
    const by = layerTitle(layer)
    notes.push(
      text(
        `现在用的模型目录由${by['zh-CN']}指定，这里改的会被它盖住`,
        `The model catalog in use comes from ${by.en}; changes here are overridden by it`,
      ),
    )
  }
  // 现在指向的清单
  let models: ModelInfo[] = []
  if (current) {
    const content = await readText(current)
    try {
      if (content === null) throw new Error('cannot read the file')
      models = parseCatalog(content)
    } catch (error) {
      const why = (error as Error).message
      notes.push(
        text(
          `模型清单 ${current} 读不出来（${why}），codex 起不来时先修好它或者在这里重写一份`,
          `The model list ${current} cannot be read (${why}); fix it or write a new one here`,
        ),
      )
    }
  }
  const foreign = current !== null && current !== litchPath
  const shippedBySlug = new Map(shipped.models.map((model) => [slugOf(model), model]))
  // 文件里原样的那些项（没记底稿，或者底稿就是它自己）
  const plain = new Map(
    models
      .filter((model) => baseOf(model) === slugOf(model))
      .map((model) => [slugOf(model), model]),
  )
  // 用户改过的自带模型：用户自己的文件里和自带的比出来；Litch 的文件里照记下的
  const owns = new Map<string, ModelInfo>()
  for (const model of models) {
    const base = baseOf(model)
    if (owns.has(base)) continue
    const shippedOne = shippedBySlug.get(base)
    const own = foreign
      ? plain.has(base) && shippedOne
        ? ownFields(plain.get(base) as ModelInfo, shippedOne)
        : null
      : isObject(model[OWN_FIELD])
        ? model[OWN_FIELD]
        : null
    if (own && Object.keys(own).length) owns.set(base, own)
  }
  const templateOf = (id: string): ModelInfo | null => {
    // 自带的打底、用户的字段盖上去；自带目录里没有的，用户文件里的就是它自己的底稿
    const shippedOne = shippedBySlug.get(id)
    if (shippedOne) return { ...shippedOne, ...owns.get(id) }
    const found = plain.get(id)
    if (found) return found
    // 底稿哪儿都找不着了（新版 codex 去掉了）：拿照它改的那一项充当，名字换回去
    const derived = models.find((model) => baseOf(model) === id)
    if (!derived) return null
    const { [BASE_FIELD]: _base, [OWN_FIELD]: _own, ...rest } = derived
    return { ...rest, slug: id, display_name: id }
  }
  const templates = new Map<string, ModelInfo>()
  const bases: HarnessModelBase[] = []
  const list = (id: string) => {
    if (templates.has(id)) return
    const template = templateOf(id)
    if (!template) return
    templates.set(id, template)
    bases.push(baseInfo(id, template))
  }
  const visible = shipped.models
    .map((model, index) => ({ model, index }))
    .filter(({ model }) => model.visibility === 'list')
    .sort(
      (a, b) =>
        (numberOf(a.model.priority) ?? 0) - (numberOf(b.model.priority) ?? 0) || a.index - b.index,
    )
  for (const { model } of visible) list(slugOf(model))
  for (const model of models) list(baseOf(model))
  const entries = models.map((model): HarnessModelEntry => {
    const id = slugOf(model)
    const base = baseOf(model)
    const template = templates.get(base)
    const name = typeof model.display_name === 'string' ? model.display_name : null
    const window = numberOf(model.context_window)
    // 和底稿一样的报 null（照底稿）；底稿是用户文件里它自己时也是
    return {
      id,
      base,
      displayName: template && name === template.display_name ? null : name,
      contextWindow: template && window === numberOf(template.context_window) ? null : window,
    }
  })
  const model = snapshot.config.model
  if (
    current &&
    models.length &&
    typeof model === 'string' &&
    !models.some((item) => slugOf(item) === model)
  )
    notes.push(
      text(
        `默认模型 ${model} 不在清单里，codex 会用通用的设置跑它；在设置里换一个清单里的模型，或者把它加进清单`,
        `The default model ${model} is not in the list, so codex runs it with generic settings; pick a model from the list or add it`,
      ),
    )
  return {
    snapshot,
    litchPath,
    current,
    userPath,
    templates,
    owns,
    bases,
    entries,
    version: await versionOf(snapshot, current, litchPath),
    notes,
    readOnlyReason,
  }
}

function joinNotes(notes: HarnessText[]): HarnessText | null {
  if (!notes.length) return null
  return text(
    notes.map((note) => note['zh-CN']).join('；'),
    notes.map((note) => note.en).join('; '),
  )
}

/** litch/harness/models/read */
export async function readCodexModels(context: ModelsContext): Promise<HarnessModelsReadResponse> {
  const state = await readState(context)
  const custom = state.current !== null
  return {
    custom,
    entries: custom ? state.entries : [],
    bases: state.bases,
    path: custom ? state.current : state.litchPath,
    version: state.version,
    effect: 'harness',
    note: joinNotes(state.notes),
    readOnlyReason: state.readOnlyReason,
  }
}

function invalid(harness: string, key: string, zh: string, en: string): HarnessConfigError {
  return new HarnessConfigError('invalidValue', harness, text(zh, en), key)
}

/** 核对要写的清单，一项不对整个不写；对的话给出每一项的完整 ModelInfo */
function build(harness: string, state: CatalogState, given: unknown): ModelInfo[] {
  if (!Array.isArray(given) || given.length === 0)
    throw invalid(
      harness,
      'entries',
      'entries 要是非空的数组；不用自定义清单请传 null',
      'entries must be a non-empty array; pass null to stop using a custom list',
    )
  const listed = new Set(state.bases.map((base) => base.id))
  const seen = new Set<string>()
  return given.map((entry: unknown, index): ModelInfo => {
    const at = (field: string) => `entries[${index}].${field}`
    if (!isObject(entry))
      throw invalid(harness, `entries[${index}]`, '每一项要是对象', 'Each entry must be an object')
    const { id, displayName, contextWindow, base } = entry
    if (typeof id !== 'string' || !id.trim() || id !== id.trim())
      throw invalid(
        harness,
        at('id'),
        '模型名不能为空，前后不能有空格',
        'The model name must be non-empty with no surrounding spaces',
      )
    if (seen.has(id))
      throw invalid(harness, at('id'), `模型名 ${id} 重复了`, `The model name ${id} appears twice`)
    seen.add(id)
    if (displayName !== null && (typeof displayName !== 'string' || !displayName.trim()))
      throw invalid(
        harness,
        at('displayName'),
        '显示名要么不填（null），要么不能为空',
        'displayName must be null or a non-empty string',
      )
    if (
      contextWindow !== null &&
      !(Number.isSafeInteger(contextWindow) && (contextWindow as number) > 0)
    )
      throw invalid(
        harness,
        at('contextWindow'),
        '上下文窗口要是正整数',
        'contextWindow must be a positive integer',
      )
    if (typeof base !== 'string' || !listed.has(base))
      throw invalid(
        harness,
        at('base'),
        `没有可以照着的模型 ${String(base)}`,
        `${String(base)} is not one of the available bases`,
      )
    const template = state.templates.get(base) as ModelInfo
    const { [BASE_FIELD]: _base, [OWN_FIELD]: _own, ...model } = structuredClone(template)
    model.slug = id
    model.display_name =
      displayName ?? (typeof template.display_name === 'string' ? template.display_name : id)
    if (contextWindow !== null) {
      const window = contextWindow as number
      model.context_window = window
      const max = numberOf(model.max_context_window)
      if (max !== null && max < window) model.max_context_window = window
      if (window !== numberOf(template.context_window)) delete model.auto_compact_token_limit
    }
    model.visibility = 'list'
    model.priority = index
    if (base !== id) model[BASE_FIELD] = base
    const own = state.owns.get(base)
    if (own) model[OWN_FIELD] = structuredClone(own)
    return model
  })
}

/** 先写到旁边的临时文件再换名，codex 不会读到写了一半的清单 */
async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, content, { mode: 0o600 })
  await rename(temporary, path)
}

/** litch/harness/models/write */
export async function writeCodexModels(
  context: ModelsContext,
  params: Record<string, unknown>,
): Promise<HarnessModelsWriteResponse> {
  const { ask, harness } = context
  if (typeof params.expectedVersion !== 'string')
    throw new HarnessConfigError(
      'invalidValue',
      harness,
      text('缺少 expectedVersion', 'expectedVersion is required'),
      'expectedVersion',
    )
  if (params.entries === undefined)
    throw invalid(harness, 'entries', '缺少 entries', 'entries is required')
  const state = await readState(context)
  if (state.readOnlyReason) throw new HarnessConfigError('readOnly', harness, state.readOnlyReason)
  if (params.expectedVersion !== state.version)
    throw new HarnessConfigError(
      'versionConflict',
      harness,
      text('模型清单在读过之后被改过了，请重读再改', 'The model list changed since it was read'),
    )
  const { snapshot, litchPath } = state
  if (params.entries === null) {
    // 不用自定义清单：删掉指向，Litch 的文件留着（再打开时还在）
    if (snapshot.user[KEY] === undefined) return { version: state.version, restartRequired: false }
    await batchWrite(
      ask,
      harness,
      snapshot,
      [{ keyPath: KEY, value: null, mergeStrategy: 'replace' }],
      snapshot.version,
    )
    return { version: await after(context, litchPath), restartRequired: true }
  }
  const models = build(harness, state, params.entries)
  const previous = await readText(litchPath)
  await writeAtomic(litchPath, `${JSON.stringify({ models }, null, 2)}\n`)
  if (state.userPath !== litchPath)
    try {
      await batchWrite(
        ask,
        harness,
        snapshot,
        [{ keyPath: KEY, value: litchPath, mergeStrategy: 'replace' }],
        snapshot.version,
      )
    } catch (error) {
      // 指向没改成：清单文件放回原样，免得 Litch 的文件和配置对不上
      if (previous === null) await rm(litchPath, { force: true })
      else await writeAtomic(litchPath, previous)
      throw error
    }
  return { version: await after(context, litchPath), restartRequired: true }
}

/** 写完之后的版本 */
async function after(context: ModelsContext, litchPath: string): Promise<string> {
  const snapshot = await readSnapshot(context.ask, context.harness)
  return versionOf(snapshot, pointing(snapshot).current, litchPath)
}
