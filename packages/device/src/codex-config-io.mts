// 原生 codex 的配置怎么读、怎么写（harness 详情设置的翻译用，codex-harness-config.mts）。
// 依据：上游 rust-v0.162.0-alpha.20 的 app-server（config_manager_service.rs）和 codex 0.160.0 的实测。
//   - 读：`config/read` 带 includeLayers，拿到生效的配置、每个键来自哪一层（origins）、各层的原文和版本。
//     用户层（type user）一直在，config.toml 还没有时它的 config 是空表；它的 version 就是写入时要带的 expectedVersion。
//     我们对外报的 version 就是用户层的这个版本：配置项、provider、MCP 都落在同一个 config.toml 上。
//   - 写：`config/batchWrite` 一次写若干个键，要么全成要么全不成；一律带 filePath（用户层的文件）和 expectedVersion，
//     版本对不上回 -32600，data.config_write_error_code 是 configVersionConflict。只许写用户层，不写 profiles.*
//     （上游也拒绝）。改的是 TOML 里那几个键，别的内容和注释原样留着（实测）。
//   - 键路径按点分段，段里有点、斜杠这类字的要加引号（`hooks.state."/x/h.json:pre_tool_use:0:0".enabled`，实测认）。
//   - model_provider 写成不存在的 provider 之后 config/read 就整个失败（实测 -32603），所以切换前要先核对。
import { HarnessConfigError, text } from './harness-config.mjs'
import { isObject, UpstreamRpcError } from './wire.mjs'

export type Ask = (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>

export interface CodexLayer {
  name: Record<string, unknown>
  version: string
  config: Record<string, unknown>
}

export interface CodexSnapshot {
  /** 生效的配置 */
  config: Record<string, unknown>
  /** 每个键（点分的路径）来自哪一层 */
  origins: Record<string, { name: Record<string, unknown>; version: string }>
  /** 用户层的原文（写过的才有） */
  user: Record<string, unknown>
  /** 全部的层，排在前面的优先（用户层在系统层前面，项目层、命令行参数在用户层前面） */
  layers: CodexLayer[]
  /** 用户层的版本：写入时带的 expectedVersion，也是我们对外的 version */
  version: string
  /** 用户层的文件（config.toml） */
  file: string
  /** configRequirements/read 的 requirements；没有是 null */
  requirements: Record<string, unknown> | null
}

/** 一段键名：只有字母、数字、- _ 的原样写，别的加引号（引号和反斜杠转义） */
export function segment(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : `"${name.replace(/["\\]/g, (ch) => `\\${ch}`)}"`
}

/** 按我们自己的键（点分，可以带引号段）拆成段，规矩和上游的 parse_key_path 一样 */
export function splitKey(key: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < key.length; index++) {
    const ch = key[index] as string
    if (ch === '"' && !quoted && current === '') quoted = true
    else if (ch === '"' && quoted) quoted = false
    else if (ch === '\\' && quoted) current += key[++index] ?? ''
    else if (ch === '.' && !quoted) {
      parts.push(current)
      current = ''
    } else current += ch
  }
  parts.push(current)
  return parts
}

/** 嵌套对象里按段取值 */
export function valueAt(root: unknown, path: string[]): unknown {
  let value: unknown = root
  for (const part of path) {
    if (!isObject(value)) return undefined
    value = value[part]
  }
  return value
}

/** 这一层给人看的名字 */
export function layerTitle(name: Record<string, unknown>) {
  switch (name.type) {
    case 'system':
      return text('系统配置（/etc/codex）', 'System config (/etc/codex)')
    case 'mdm':
    case 'enterpriseManaged':
    case 'legacyManagedConfigTomlFromFile':
    case 'legacyManagedConfigTomlFromMdm':
      return text('管理员下发的配置', 'Managed configuration')
    case 'sessionFlags':
      return text('启动 codex 时的命令行参数', 'Command-line overrides of the running codex')
    case 'project':
      return text('项目里的 .codex 配置', 'Project .codex configuration')
    case 'packagedDefaults':
      return text('codex 自带的默认配置', 'Packaged defaults')
    default:
      return text(`配置层 ${String(name.type)}`, `Config layer ${String(name.type)}`)
  }
}

/**
 * key 生效的值是不是来自比用户层更优先的一层（命令行参数、项目、管理员）：是的话给出那一层。
 * 系统层、自带默认在用户层之下，不算盖住
 */
export function overridingLayer(
  snapshot: CodexSnapshot,
  path: string[],
): Record<string, unknown> | null {
  const origin = snapshot.origins[path.join('.')]
  if (!origin || !isObject(origin.name)) return null
  const userIndex = snapshot.layers.findIndex((layer) => layer.name?.type === 'user')
  const index = snapshot.layers.findIndex(
    (layer) => layer.version === origin.version && layer.name?.type === origin.name.type,
  )
  return index >= 0 && index < userIndex ? origin.name : null
}

/** 读一遍：配置、各层、要求 */
export async function readSnapshot(ask: Ask, harness: string): Promise<CodexSnapshot> {
  const [read, required] = await Promise.all([
    ask('config/read', { includeLayers: true }),
    ask('configRequirements/read', {}).catch(() => null),
  ])
  if (!isObject(read) || !isObject(read.config))
    throw new HarnessConfigError(
      'unavailable',
      harness,
      text('codex 没有给回配置', 'codex did not return its configuration'),
    )
  const layers = Array.isArray(read.layers) ? (read.layers as CodexLayer[]) : []
  const user = layers.find((layer) => isObject(layer?.name) && layer.name.type === 'user')
  if (!user || typeof user.version !== 'string' || typeof user.name.file !== 'string')
    throw new HarnessConfigError(
      'unavailable',
      harness,
      text('codex 的配置里没有用户层', 'codex reported no user config layer'),
    )
  return {
    config: read.config,
    origins: (isObject(read.origins) ? read.origins : {}) as CodexSnapshot['origins'],
    user: isObject(user.config) ? user.config : {},
    layers,
    version: user.version,
    file: user.name.file,
    requirements:
      isObject(required) && isObject(required.requirements) ? required.requirements : null,
  }
}

export interface CodexEdit {
  keyPath: string
  value: unknown
  mergeStrategy: 'replace' | 'upsert'
}

/** 上游写配置回的错误换成这个扩展的错误；不是写配置的错误原样抛 */
export function writeFailure(error: unknown, harness: string): unknown {
  if (!(error instanceof UpstreamRpcError)) return error
  const code = isObject(error.data) ? error.data.config_write_error_code : undefined
  const said = text(`codex 拒绝了：${error.message}`, `codex refused: ${error.message}`)
  switch (code) {
    case 'configVersionConflict':
      return new HarnessConfigError(
        'versionConflict',
        harness,
        text('配置在读过之后被改过了，请重读再改', 'The configuration changed since it was read'),
      )
    case 'configLayerReadonly':
    case 'configRequirementReadonly':
      return new HarnessConfigError('readOnly', harness, said)
    case 'configValidationError':
    case 'configSchemaUnknownKey':
    case 'configPathNotFound':
      return new HarnessConfigError('invalidValue', harness, said)
    default:
      return error
  }
}

/** 写若干个键，返回新的版本 */
export async function batchWrite(
  ask: Ask,
  harness: string,
  snapshot: CodexSnapshot,
  edits: CodexEdit[],
  expectedVersion: string,
): Promise<{ version: string; overridden: boolean }> {
  if (expectedVersion !== snapshot.version)
    throw new HarnessConfigError(
      'versionConflict',
      harness,
      text('配置在读过之后被改过了，请重读再改', 'The configuration changed since it was read'),
    )
  if (edits.length === 0) return { version: snapshot.version, overridden: false }
  try {
    const result = await ask('config/batchWrite', {
      edits,
      filePath: snapshot.file,
      expectedVersion,
    })
    const fields = isObject(result) ? result : {}
    return {
      version: typeof fields.version === 'string' ? fields.version : snapshot.version,
      overridden: fields.status === 'okOverridden',
    }
  } catch (error) {
    throw writeFailure(error, harness)
  }
}

/** 必须是字符串的参数 */
export function requiredText(value: unknown, field: string, harness: string): string {
  if (typeof value === 'string' && value) return value
  throw new HarnessConfigError(
    'invalidValue',
    harness,
    text(`缺少 ${field}，或者它不是字符串`, `${field} is missing or not a string`),
    field,
  )
}
