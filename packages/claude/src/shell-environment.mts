// 模型的 Bash 命令的环境变量：照 codex 的 `shell_environment_policy`（rust-v0.163.0：
// codex-rs/config/src/shell_environment_policy.rs 的解析，codex-rs/protocol/src/shell_environment.rs 的
// populate_env）。顺序：按 inherit 取底（all 全部、core 只留几个基本变量、none 清空）→ 默认排除（名字含
// KEY、SECRET、TOKEN 的；ignore_default_excludes 默认为 true，即默认不排除）→ exclude → set → include_only。
// 名字按通配符（`*`、`?`）不分大小写匹配。
//
// 命令由 CLI 起，入口拿不到它的环境，所以把这套规则写成命令前面的一段 bash：在命令自己的 shell 里按真实环境
// 删、改变量，再跑原命令。set 的值因此出现在命令行里（同 uid 的进程能从 /proc 读到，和读环境变量一样）。
// 规则等于默认（全继承、什么都不改）时命令原样不动。
import { isConfigObject } from './config-store.mjs'
import { ProtocolError } from './protocol-contract.mjs'

export interface ShellEnvironmentPolicy {
  inherit: 'all' | 'core' | 'none'
  ignoreDefaultExcludes: boolean
  exclude: string[]
  set: Record<string, string>
  includeOnly: string[]
}

// codex 的 UNIX_CORE_ENV_VARS
const CORE_VARS = [
  'PATH',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'USER',
]
const DEFAULT_EXCLUDES = ['*KEY*', '*SECRET*', '*TOKEN*']
const KNOWN_KEYS = new Set([
  'inherit',
  'ignore_default_excludes',
  'exclude',
  'set',
  'include_only',
  'filters',
  'experimental_use_profile',
])

function invalid(message: string): never {
  throw new ProtocolError(-32602, `shell_environment_policy ${message}`)
}

function patterns(value: unknown, key: string): string[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    invalid(`的 ${key} 必须是字符串数组`)
  return value as string[]
}

// 配置里的表 → 规则；没配是 null。写法不对报 -32602（codex 同样拒绝未知的键）
export function resolveShellEnvironmentPolicy(value: unknown): ShellEnvironmentPolicy | null {
  if (value == null) return null
  if (!isConfigObject(value)) invalid('必须是表')
  for (const key of Object.keys(value)) if (!KNOWN_KEYS.has(key)) invalid(`不认识 ${key}`)
  const inherit = value.inherit ?? 'all'
  if (inherit !== 'all' && inherit !== 'core' && inherit !== 'none')
    invalid('的 inherit 只能是 all、core、none')
  const ignore = value.ignore_default_excludes ?? true
  if (typeof ignore !== 'boolean') invalid('的 ignore_default_excludes 必须是布尔值')
  const set = value.set ?? {}
  if (!isConfigObject(set) || Object.values(set).some((item) => typeof item !== 'string'))
    invalid('的 set 必须是“变量名 → 字符串”的表')
  for (const name of Object.keys(set))
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) invalid(`的 set 里 ${name} 不是合法的变量名`)
  let exclude = patterns(value.exclude, 'exclude')
  let includeOnly = patterns(value.include_only, 'include_only')
  if (value.filters != null) {
    if (value.exclude != null || value.include_only != null)
      invalid('的 filters 不能和 exclude、include_only 混用')
    if (!isConfigObject(value.filters)) invalid('的 filters 必须是表')
    const seen = new Set<string>()
    exclude = []
    includeOnly = []
    for (const [pattern, action] of Object.entries(value.filters)) {
      if (seen.has(pattern.toLowerCase())) invalid(`的 filters 里 ${pattern} 不分大小写重复了`)
      seen.add(pattern.toLowerCase())
      if (action === 'include') includeOnly.push(pattern)
      else if (action === 'exclude') exclude.push(pattern)
      else invalid(`的 filters 里 ${pattern} 只能是 include 或 exclude`)
    }
  }
  return {
    inherit,
    ignoreDefaultExcludes: ignore,
    exclude,
    set: set as Record<string, string>,
    includeOnly,
  }
}

function isDefault(policy: ShellEnvironmentPolicy): boolean {
  return (
    policy.inherit === 'all' &&
    policy.ignoreDefaultExcludes &&
    policy.exclude.length === 0 &&
    Object.keys(policy.set).length === 0 &&
    policy.includeOnly.length === 0
  )
}

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

// 通配符模式 → bash 的 [[ == ]] 右边：`*`、`?` 照用，其余字符加引号按字面比
function globPattern(pattern: string): string {
  return pattern
    .split(/([*?])/)
    .map((part) => (part === '*' || part === '?' ? part : part ? quote(part) : ''))
    .join('')
}

function anyMatch(list: string[]): string {
  return list.map((pattern) => `[[ $__cha_n == ${globPattern(pattern)} ]]`).join(' || ')
}

// 包好的命令：bash 里先按规则删、改变量，再跑原命令。LITCH_THREAD_ID 和 codex 的 CODEX_THREAD_ID 一样
// 总是留着（命令里的 litch-machine 靠它认会话）
export function shellEnvironmentCommand(
  policy: ShellEnvironmentPolicy | null | undefined,
  command: string,
): string {
  if (!policy || isDefault(policy)) return command
  const removals: string[] = []
  if (policy.inherit === 'none') removals.push('true')
  if (policy.inherit === 'core') removals.push(`! ( ${anyMatch(CORE_VARS)} )`)
  if (!policy.ignoreDefaultExcludes) removals.push(anyMatch(DEFAULT_EXCLUDES))
  if (policy.exclude.length > 0) removals.push(anyMatch(policy.exclude))
  const lines = ['__cha_tid=${LITCH_THREAD_ID-}', 'shopt -s nocasematch']
  if (removals.length > 0)
    lines.push(
      'for __cha_n in $(compgen -e); do',
      `  if ${removals.map((condition) => `{ ${condition}; }`).join(' || ')}; then unset "$__cha_n" 2>/dev/null; fi`,
      'done',
    )
  for (const [name, value] of Object.entries(policy.set))
    lines.push(`export ${name}=${quote(value)}`)
  if (policy.includeOnly.length > 0)
    lines.push(
      'for __cha_n in $(compgen -e); do',
      `  if ! { ${anyMatch(policy.includeOnly)}; }; then unset "$__cha_n" 2>/dev/null; fi`,
      'done',
    )
  lines.push(
    'shopt -u nocasematch',
    '[ -n "$__cha_tid" ] && export LITCH_THREAD_ID="$__cha_tid"',
    'unset __cha_n __cha_tid',
    command,
  )
  return ['/bin/bash', '--noprofile', '--norc', '-c', lines.join('\n')].map(quote).join(' ')
}
