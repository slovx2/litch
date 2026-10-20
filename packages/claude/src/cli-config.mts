// `app-server -c key=<TOML 值>`：照 codex 的命令行配置覆盖（codex-rs/utils/cli/src/config_override.rs、
// codex-rs/config/src/overrides.rs）。键按 `.` 拆成路径，值按 TOML 解析，解析不了就当字符串；
// 多次给同一个键后面的为准。只收白名单里的键，其余（WakeQora 这类调用方会顺手传 codex 专有的键）记日志后忽略。
// 收下的这一层叠在 config.json 上面（loadPersistedConfig），只在内存里，不写回 config.json。
import { parse } from 'smol-toml'
import { isConfigObject } from './config-store.mjs'
import { debugLog } from './util.mjs'

type ConfigTable = Record<string, unknown>

// 整个键就是它（approval_policy），或者以它开头的表（permissions.x.filesystem）
const scalarKeys = new Set([
  'approval_policy',
  'sandbox_mode',
  'default_permissions',
  'developer_instructions',
])
const tableKeys = new Set(['permissions', 'mcp_servers'])

let layer: ConfigTable = {}

export function cliConfigLayer(): ConfigTable {
  return layer
}

export function setCliConfigLayer(next: ConfigTable): void {
  layer = next
}

// 从命令行参数里取出 `-c`/`--config`（`-c k=v`、`--config k=v`、`--config=k=v`），按出现顺序
export function cliConfigArgs(args: readonly string[]): string[] {
  const raw: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    if (arg === '-c' || arg === '--config') {
      const value = args[index + 1]
      if (value === undefined) throw new Error(`${arg} 缺少 key=value`)
      raw.push(value)
      index += 1
    } else if (arg.startsWith('--config=')) raw.push(arg.slice('--config='.length))
  }
  return raw
}

export function parseCliOverride(raw: string): [string, unknown] {
  const separator = raw.indexOf('=')
  if (separator < 0) throw new Error(`配置覆盖缺少“=”：${raw}`)
  const key = raw.slice(0, separator).trim()
  const text = raw.slice(separator + 1).trim()
  if (!key) throw new Error(`配置覆盖的键为空：${raw}`)
  let value: unknown
  try {
    value = plain(parse(`_x_ = ${text}`)._x_)
  } catch {
    // 与 codex 相同：不是合法 TOML 就去掉两头的引号当字符串（`-c model=o3`）
    value = text.replace(/^["']+|["']+$/g, '')
  }
  return [key, value]
}

// 这几个键写进普通对象会改到原型上，键里任何一段是它们都整条忽略
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype'])

// smol-toml 给的表没有原型，换成普通对象，和 config.json 读出来的一样
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain)
  if (isConfigObject(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !unsafeKeys.has(key))
        .map(([key, item]) => [key, plain(item)]),
    )
  return value
}

function accepted(key: string): boolean {
  const segments = key.split('.')
  if (segments.some((segment) => unsafeKeys.has(segment))) return false
  return scalarKeys.has(key) || tableKeys.has(segments[0] as string)
}

// 一条覆盖写进树里：沿途不是表的换成表，最后一段整个替换
function applyOverride(root: ConfigTable, key: string, value: unknown): void {
  const segments = key.split('.')
  let current = root
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment]
    if (!isConfigObject(next)) current[segment] = {}
    current = current[segment] as ConfigTable
  }
  current[segments.at(-1) as string] = value
}

export function buildCliConfigLayer(rawOverrides: readonly string[]): ConfigTable {
  const root: ConfigTable = {}
  const ignored: string[] = []
  for (const raw of rawOverrides) {
    const [key, value] = parseCliOverride(raw)
    if (accepted(key)) applyOverride(root, key, value)
    else ignored.push(key)
  }
  if (ignored.length > 0) debugLog('config.cliOverride.ignored', { keys: ignored })
  return root
}

// 上层叠到下层：两边都是表就逐键合并，否则上层整个替换（codex 的 merge_toml_values）
export function mergeConfigLayers(base: ConfigTable, overlay: ConfigTable): ConfigTable {
  const merged: ConfigTable = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    if (unsafeKeys.has(key)) continue
    const existing = merged[key]
    merged[key] =
      isConfigObject(existing) && isConfigObject(value) ? mergeConfigLayers(existing, value) : value
  }
  return merged
}
