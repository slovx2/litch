// harness 详情设置（harnessConfig 扩展）的 Claude Code 实现：litch/harness/* 全套方法。
// 约定在 packages/protocol/src/harness-config.mts。权威都在 Claude Code 自己的文件里：
// - 配置项：<配置目录>/settings.json（跟随 CLAUDE_CONFIG_DIR），认不出的键原样保留；hooks 只读列出
// - MCP：~/.claude.json 顶层的 mcpServers（等同 `claude mcp add -s user`），文件其余部分不动
// - 指令：<配置目录>/CLAUDE.md
// - 账号与 provider：claude-provider.mts（选择）、claude-auth.mts（`claude auth` 子进程）
// 配置项、MCP、指令的改动都是新开的会话才用上（适配器每个会话起一份 CLI，起的时候读这些文件）。
import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type {
  HarnessAuthStartResponse,
  HarnessAuthStep,
  HarnessConfigChangedNotification,
  HarnessConfigFile,
  HarnessConfigReadResponse,
  HarnessConfigWriteResponse,
  HarnessInstructionsInfo,
  HarnessInstructionsWriteResponse,
  HarnessMcpReadResponse,
  HarnessMcpServer,
  HarnessMcpTransport,
  HarnessMcpWriteResponse,
  HarnessSettingGroup,
  HarnessSettingOption,
  HarnessSettingSpec,
  HarnessSettingValue,
  HarnessText,
} from '../../protocol/src/harness-config.mjs'
import {
  HARNESS_CONFIG_METHOD,
  HARNESS_CONFIG_NOTIFICATION,
} from '../../protocol/src/harness-config.mjs'
import { settingsModelValue } from './claude-default-model.mjs'
import {
  claudeConfigDir,
  claudeGlobalConfigPath,
  claudeInstructionsPath,
  claudeManagedSettingsPath,
  claudeSettingsPath,
  contentHash,
  getAtPath,
  parseKeyPath,
  quoteKeySegment,
  readJsonObject,
  readTextFile,
  setAtPath,
  symlinkTarget,
  writeJsonObject,
  writeTextFileAtomic,
} from './claude-native-files.mjs'
import { CLAUDE_HARNESS_ID, fileError, HarnessConfigError, text } from './harness-config-common.mjs'
import { ClaudeProviders, type ProvidersHost } from './harness-providers.mjs'
import { ProtocolError } from './protocol-contract.mjs'
import { newId } from './util.mjs'

// ---------- 配置项的结构 ----------

const GROUPS: HarnessSettingGroup[] = [
  { id: 'defaults', title: text('默认模型与强度', 'Defaults'), description: null },
  {
    id: 'permissions',
    title: text('权限', 'Permissions'),
    description: text(
      '规则写法同 Claude Code 的 permissions，例如 Bash(npm run test:*)、Read(~/.ssh/**)。',
      'Same syntax as Claude Code permissions, e.g. Bash(npm run test:*), Read(~/.ssh/**).',
    ),
  },
  { id: 'behavior', title: text('行为与输出', 'Behavior'), description: null },
  { id: 'memory', title: text('记忆', 'Memory'), description: null },
  {
    id: 'tools',
    title: text('插件与 hooks', 'Plugins and hooks'),
    description: text(
      'hooks 只读列出，要改请编辑 settings.json。',
      'Hooks are listed read-only; edit settings.json to change them.',
    ),
  },
  { id: 'advanced', title: text('其他', 'Advanced'), description: null },
]

const PERMISSION_MODES: HarnessSettingOption[] = [
  { value: 'default', title: text('每次询问', 'Ask (default)') },
  { value: 'acceptEdits', title: text('自动接受改文件', 'Accept edits') },
  { value: 'plan', title: text('计划模式', 'Plan mode') },
  { value: 'auto', title: text('自动', 'Auto') },
  { value: 'dontAsk', title: text('不询问（未允许的拒绝）', "Don't ask") },
  { value: 'bypassPermissions', title: text('跳过所有权限检查', 'Bypass permissions') },
]

const EFFORT_OPTIONS: HarnessSettingOption[] = [
  { value: 'low', title: text('低', 'Low') },
  { value: 'medium', title: text('中', 'Medium') },
  { value: 'high', title: text('高', 'High') },
  { value: 'xhigh', title: text('超高', 'Extra high') },
]

type SpecInput = Omit<HarnessSettingSpec, 'description' | 'default' | 'effect'> & {
  description?: HarnessText | null
  default?: HarnessSettingValue | null
  effect?: HarnessSettingSpec['effect']
}

function spec(input: SpecInput): HarnessSettingSpec {
  return { description: null, default: null, effect: 'newSession', ...input }
}

function staticSpecs(models: HarnessSettingOption[]): HarnessSettingSpec[] {
  return [
    spec({
      key: 'model',
      group: 'defaults',
      type: 'enum',
      title: text('默认模型', 'Default model'),
      description: text(
        '不写时用 Claude Code 自己的默认模型。Litch 新建会话时默认选它。',
        "Unset uses Claude Code's own default. Litch preselects it for new sessions.",
      ),
      options: models,
      allowCustom: true,
      placeholder: 'opus / sonnet / claude-opus-4-1',
    }),
    spec({
      key: 'effortLevel',
      group: 'defaults',
      type: 'enum',
      title: text('推理强度', 'Effort'),
      description: text('支持的模型才有效。', 'Only for models that support it.'),
      options: EFFORT_OPTIONS,
    }),
    spec({
      key: 'fastMode',
      group: 'defaults',
      type: 'boolean',
      title: text('快速模式', 'Fast mode'),
      description: text('只对支持的模型和账号有效。', 'Only for supported models and plans.'),
      default: false,
    }),
    spec({
      key: 'alwaysThinkingEnabled',
      group: 'defaults',
      type: 'boolean',
      title: text('思考', 'Thinking'),
      description: text('关掉后不再自动开启思考。', 'When off, thinking is not enabled.'),
      default: true,
    }),
    spec({
      key: 'permissions.defaultMode',
      group: 'permissions',
      type: 'enum',
      title: text('默认权限模式', 'Default permission mode'),
      description: text(
        '设备上直接用命令行起的会话用它；Litch 里的会话按会话自己的权限档。',
        'Used by sessions started from the CLI on the device; Litch sessions use their own permission preset.',
      ),
      options: PERMISSION_MODES,
      default: 'default',
    }),
    spec({
      key: 'permissions.allow',
      group: 'permissions',
      type: 'stringList',
      title: text('允许', 'Allow'),
      description: text('不用询问直接放行的工具规则。', 'Tool rules allowed without asking.'),
    }),
    spec({
      key: 'permissions.ask',
      group: 'permissions',
      type: 'stringList',
      title: text('总是询问', 'Always ask'),
      description: null,
    }),
    spec({
      key: 'permissions.deny',
      group: 'permissions',
      type: 'stringList',
      title: text('拒绝', 'Deny'),
      description: null,
    }),
    spec({
      key: 'language',
      group: 'behavior',
      type: 'string',
      title: text('回答语言', 'Response language'),
      description: text('例如：简体中文、English。', 'For example: English, Japanese.'),
      placeholder: '简体中文',
    }),
    spec({
      key: 'attribution.commit',
      group: 'behavior',
      type: 'text',
      title: text('提交署名', 'Commit attribution'),
      description: text(
        'Claude 提交 git 时附加的署名（含 trailer）；空串表示不加。不写用默认署名。',
        'Attribution appended to git commits; empty hides it. Unset uses the default.',
      ),
    }),
    spec({
      key: 'attribution.pr',
      group: 'behavior',
      type: 'text',
      title: text('PR 署名', 'Pull request attribution'),
      description: text('空串表示不加。', 'Empty hides it.'),
    }),
    spec({
      key: 'autoCompactEnabled',
      group: 'behavior',
      type: 'boolean',
      title: text('自动压缩上下文', 'Auto-compact'),
      description: text('上下文快满时自动压缩。', 'Compact automatically when context fills.'),
      default: true,
    }),
    spec({
      key: 'autoMemoryEnabled',
      group: 'memory',
      type: 'boolean',
      title: text('自动记忆', 'Auto memory'),
      description: text(
        '关掉后不读也不写自动记忆目录。',
        'When off, Claude does not read or write the auto-memory directory.',
      ),
      default: true,
    }),
    spec({
      key: 'extraKnownMarketplaces',
      group: 'tools',
      type: 'json',
      title: text('插件市场', 'Plugin marketplaces'),
      description: text(
        '额外的插件市场，形如 {"名字": {"source": {"source": "github", "repo": "owner/repo"}}}。',
        'Extra marketplaces, e.g. {"name": {"source": {"source": "github", "repo": "owner/repo"}}}.',
      ),
    }),
    spec({
      key: 'hooks',
      group: 'tools',
      type: 'json',
      title: text('hooks', 'Hooks'),
      description: null,
      readOnly: true,
      readOnlyReason: text(
        'hooks 只读列出，请直接编辑 settings.json。',
        'Edit settings.json directly.',
      ),
      clearable: false,
    }),
    spec({
      key: 'cleanupPeriodDays',
      group: 'advanced',
      type: 'integer',
      title: text('会话记录保留天数', 'Transcript retention (days)'),
      default: 30,
      minimum: 1,
    }),
    spec({
      key: 'autoUpdatesChannel',
      group: 'advanced',
      type: 'enum',
      title: text('更新通道', 'Update channel'),
      effect: 'none',
      default: 'latest',
      options: [
        { value: 'latest', title: text('最新', 'Latest') },
        { value: 'stable', title: text('稳定', 'Stable') },
        { value: 'rc', title: text('候选', 'Release candidate') },
      ],
    }),
  ]
}

// 插件：装过的（plugins/installed_plugins.json）和 settings 里提到过的，每个一个开关
function pluginIds(settings: Record<string, unknown>): string[] {
  const ids = new Set<string>()
  const enabled = settings.enabledPlugins
  if (enabled && typeof enabled === 'object' && !Array.isArray(enabled))
    for (const id of Object.keys(enabled)) ids.add(id)
  try {
    const installed = readJsonObject(join(claudeConfigDir(), 'plugins', 'installed_plugins.json'))
      .value.plugins
    if (installed && typeof installed === 'object' && !Array.isArray(installed))
      for (const id of Object.keys(installed)) ids.add(id)
  } catch {}
  return [...ids].sort()
}

function pluginSpecs(settings: Record<string, unknown>): HarnessSettingSpec[] {
  return pluginIds(settings).map((id) =>
    spec({
      key: `enabledPlugins.${quoteKeySegment(id)}`,
      group: 'tools',
      type: 'boolean',
      title: text(`插件 ${id}`, `Plugin ${id}`),
      description: null,
      default: false,
    }),
  )
}

// 输出风格：内置的三种，加上 <配置目录>/output-styles 下的自定义风格
function outputStyleSpec(): HarnessSettingSpec {
  const options: HarnessSettingOption[] = [
    { value: 'default', title: text('默认', 'Default') },
    { value: 'Explanatory', title: text('讲解', 'Explanatory') },
    { value: 'Learning', title: text('学习', 'Learning') },
  ]
  try {
    for (const entry of readdirSync(join(claudeConfigDir(), 'output-styles')))
      if (entry.endsWith('.md')) {
        const name = basename(entry, '.md')
        options.push({ value: name, title: text(name, name) })
      }
  } catch {}
  return spec({
    key: 'outputStyle',
    group: 'behavior',
    type: 'enum',
    title: text('输出风格', 'Output style'),
    options,
    allowCustom: true,
    default: 'default',
  })
}

// ---------- 配置项的读写 ----------

function readManagedSettings(): Record<string, unknown> {
  try {
    return readJsonObject(claudeManagedSettingsPath()).value
  } catch {
    return {}
  }
}

function settingsFiles(): HarnessConfigFile[] {
  const files: HarnessConfigFile[] = [
    { role: 'settings', path: claudeSettingsPath() },
    { role: 'mcp', path: claudeGlobalConfigPath() },
    { role: 'instructions', path: claudeInstructionsPath() },
  ]
  // macOS 上凭据在钥匙串里，没有文件
  if (process.platform !== 'darwin')
    files.push({ role: 'credentials', path: join(claudeConfigDir(), '.credentials.json') })
  if (readTextFile(claudeManagedSettingsPath()) !== null)
    files.push({ role: 'managed', path: claudeManagedSettingsPath() })
  return files
}

const MANAGED = text('管理员设置', 'Managed settings')

interface LoadedSettings {
  settings: Record<string, unknown>
  version: string
  specs: HarnessSettingSpec[]
  managed: Record<string, unknown>
}

function loadSettings(models: HarnessSettingOption[]): LoadedSettings {
  let loaded: { value: Record<string, unknown>; raw: string | null }
  try {
    loaded = readJsonObject(claudeSettingsPath())
  } catch (error) {
    fileError(error)
  }
  const managed = readManagedSettings()
  const specs = [...staticSpecs(models), outputStyleSpec(), ...pluginSpecs(loaded.value)].map(
    (item) =>
      getAtPath(managed, parseKeyPath(item.key)!) === undefined
        ? item
        : {
            ...item,
            readOnly: true,
            readOnlyReason: text('被管理员设置锁住', 'Locked by managed settings'),
          },
  )
  // 显示顺序按分组排，组内按声明的先后
  const order = new Map(GROUPS.map((group, index) => [group.id, index]))
  specs.sort((a, b) => (order.get(a.group) ?? 99) - (order.get(b.group) ?? 99))
  return { settings: loaded.value, version: contentHash(loaded.raw ?? ''), specs, managed }
}

export function readClaudeConfig(models: HarnessSettingOption[]): HarnessConfigReadResponse {
  const { settings, version, specs, managed } = loadSettings(models)
  const values: Record<string, HarnessSettingValue> = {}
  const overridden: Record<string, { value: HarnessSettingValue; by: HarnessText }> = {}
  for (const item of specs) {
    const path = parseKeyPath(item.key)!
    const value = getAtPath(settings, path)
    if (value !== undefined)
      values[item.key] = (
        item.key.startsWith('enabledPlugins.') ? value !== false : value
      ) as HarnessSettingValue
    const locked = getAtPath(managed, path)
    if (locked !== undefined)
      overridden[item.key] = { value: locked as HarnessSettingValue, by: MANAGED }
  }
  return {
    groups: GROUPS,
    settings: specs,
    values,
    ...(Object.keys(overridden).length ? { overridden } : {}),
    actions: [],
    version,
    files: settingsFiles(),
  }
}

function invalid(key: string, zh: string, en: string): never {
  throw new HarnessConfigError('invalidValue', text(`${key}：${zh}`, `${key}: ${en}`), key)
}

function validateValue(item: HarnessSettingSpec, value: unknown): unknown {
  const key = item.key
  switch (item.type) {
    case 'boolean':
      if (typeof value !== 'boolean') invalid(key, '要是开或关', 'must be a boolean')
      return value
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value))
        invalid(key, '要是数字', 'must be a number')
      if (item.type === 'integer' && !Number.isInteger(value))
        invalid(key, '要是整数', 'must be an integer')
      if (item.minimum !== undefined && value < item.minimum)
        invalid(key, `不能小于 ${item.minimum}`, `must be at least ${item.minimum}`)
      if (item.maximum !== undefined && value > item.maximum)
        invalid(key, `不能大于 ${item.maximum}`, `must be at most ${item.maximum}`)
      return value
    }
    case 'string':
    case 'text':
      if (typeof value !== 'string') invalid(key, '要是文字', 'must be a string')
      return value
    case 'enum':
      if (typeof value !== 'string' || !value.trim())
        invalid(key, '要是非空的文字', 'must be a non-empty string')
      if (!item.allowCustom && !item.options?.some((option) => option.value === value))
        invalid(key, '不在可选的值里', 'is not one of the options')
      return value.trim()
    case 'stringList':
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
        invalid(key, '要是一列文字', 'must be a list of strings')
      return value.map((entry: string) => entry.trim()).filter(Boolean)
    case 'json':
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        invalid(key, '要是 JSON 对象', 'must be a JSON object')
      return value
    default:
      invalid(key, '这一项不能写', 'cannot be written')
  }
}

export interface ClaudeConfigWriteResult extends HarnessConfigWriteResponse {
  /** 默认模型或强度改了：适配器要重读 */
  defaultsChanged: boolean
}

export function writeClaudeConfig(
  edits: unknown,
  expectedVersion: unknown,
  models: HarnessSettingOption[],
): ClaudeConfigWriteResult {
  if (!Array.isArray(edits) || edits.length === 0)
    throw new HarnessConfigError(
      'invalidValue',
      text('edits 要是非空数组', 'edits must be a non-empty array'),
    )
  if (typeof expectedVersion !== 'string')
    throw new HarnessConfigError(
      'invalidValue',
      text('缺少 expectedVersion', 'expectedVersion is required'),
    )
  const { settings, version, specs, managed } = loadSettings(models)
  if (expectedVersion !== version)
    throw new HarnessConfigError(
      'versionConflict',
      text('settings.json 已经变了，请重新读取', 'settings.json changed; reload it'),
    )
  const byKey = new Map(specs.map((item) => [item.key, item]))
  const next = structuredClone(settings)
  const overriddenKeys: string[] = []
  let defaultsChanged = false
  for (const edit of edits) {
    const key = edit && typeof edit === 'object' ? (edit as { key?: unknown }).key : undefined
    if (typeof key !== 'string')
      throw new HarnessConfigError('invalidValue', text('每一项要有 key', 'each edit needs a key'))
    const path = parseKeyPath(key)
    let item = byKey.get(key)
    // 还没出现在列表里的插件也能开关（刚装的，或者手填的 id）
    if (!item && path && path.length === 2 && path[0] === 'enabledPlugins')
      item = pluginSpecs({ enabledPlugins: { [path[1]!]: false } })[0]
    if (!item || !path)
      throw new HarnessConfigError(
        'notFound',
        text(`没有这一项：${key}`, `Unknown setting: ${key}`),
        key,
      )
    if (item.readOnly)
      throw new HarnessConfigError(
        'readOnly',
        item.readOnlyReason ?? text(`${key} 不能改`, `${key} is read-only`),
        key,
      )
    const raw = (edit as { value?: unknown }).value
    let value: unknown
    if (raw === null || raw === undefined) {
      if (item.clearable === false) invalid(key, '不能清掉', 'cannot be cleared')
      value = undefined
    } else value = validateValue(item, raw)
    if (key === 'model' && typeof value === 'string') value = settingsModelValue(value) ?? undefined
    if (key === 'model' || key === 'effortLevel') defaultsChanged = true
    setAtPath(next, path, value)
    if (getAtPath(managed, path) !== undefined) overriddenKeys.push(key)
  }
  let nextVersion = version
  if (JSON.stringify(next) !== JSON.stringify(settings)) {
    try {
      writeJsonObject(claudeSettingsPath(), next)
      nextVersion = contentHash(readTextFile(claudeSettingsPath()) ?? '')
    } catch (error) {
      fileError(error)
    }
  }
  return { version: nextVersion, overriddenKeys, restartRequired: false, defaultsChanged }
}

// ---------- MCP：~/.claude.json 顶层的 mcpServers ----------

// 名字看着像密钥的环境变量和请求头，读的时候不回显值
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE)/i
const MCP_NAME = /^[A-Za-z0-9_.-]{1,64}$/
const MCP_FIELDS = new Set(['type', 'command', 'args', 'env', 'cwd', 'url', 'headers'])

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, entry] of Object.entries(asObject(value)))
    if (typeof entry === 'string') result[name] = entry
  return result
}

function readGlobalConfig(): Record<string, unknown> {
  try {
    return readJsonObject(claudeGlobalConfigPath()).value
  } catch (error) {
    fileError(error)
  }
}

function mcpServersOf(global: Record<string, unknown>): Record<string, unknown> {
  return asObject(global.mcpServers)
}

function mcpVersion(servers: Record<string, unknown>): string {
  return contentHash(JSON.stringify(servers))
}

function mcpTransport(entry: Record<string, unknown>): HarnessMcpTransport | null {
  const type = entry.type ?? (typeof entry.command === 'string' ? 'stdio' : undefined)
  return type === 'stdio' || type === 'http' || type === 'sse' ? type : null
}

function maskSecrets(map: Record<string, string>, secretKeys: Set<string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(map).map(([name, value]) => {
      if (!SECRET_NAME.test(name)) return [name, value]
      secretKeys.add(name)
      return [name, '']
    }),
  )
}

function toMcpServer(name: string, raw: unknown): HarnessMcpServer | null {
  const entry = asObject(raw)
  const transport = mcpTransport(entry)
  // ws、sdk 这类 Litch 表单画不了的类型不列出来，写别的服务时原样保留
  if (!transport) return null
  const secretKeys = new Set<string>()
  const extra = Object.fromEntries(Object.entries(entry).filter(([key]) => !MCP_FIELDS.has(key)))
  const server: HarnessMcpServer = { name, transport, enabled: true, status: null }
  if (transport === 'stdio') {
    server.command = typeof entry.command === 'string' ? entry.command : ''
    server.args = Array.isArray(entry.args)
      ? entry.args.filter((arg) => typeof arg === 'string')
      : []
    if (typeof entry.cwd === 'string') server.cwd = entry.cwd
    server.env = maskSecrets(stringMap(entry.env), secretKeys)
  } else {
    server.url = typeof entry.url === 'string' ? entry.url : ''
    server.headers = maskSecrets(stringMap(entry.headers), secretKeys)
  }
  if (secretKeys.size) server.secretKeys = [...secretKeys]
  if (Object.keys(extra).length) server.extra = extra
  return server
}

export function readClaudeMcp(): HarnessMcpReadResponse {
  const servers = mcpServersOf(readGlobalConfig())
  return {
    servers: Object.entries(servers).flatMap(([name, raw]) => toMcpServer(name, raw) ?? []),
    transports: ['stdio', 'http', 'sse'],
    oauth: true,
    extraFields: [],
    version: mcpVersion(servers),
    files: [{ role: 'mcp', path: claudeGlobalConfigPath() }],
  }
}

// 密钥类的值：新的没给或给了空串，沿用原来的
function keepSecrets(next: Record<string, string>, previous: Record<string, string>) {
  const result = { ...next }
  for (const [name, value] of Object.entries(previous))
    if (SECRET_NAME.test(name) && !result[name]) result[name] = value
  return result
}

function mcpEntry(server: unknown, previous: Record<string, unknown>): Record<string, unknown> {
  const input = asObject(server)
  const transport = input.transport
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse')
    invalid('transport', '只支持 stdio、http、sse', 'must be stdio, http or sse')
  if (input.enabled === false)
    invalid(
      'enabled',
      'Claude Code 没有用户级的停用开关，不用了请删掉',
      'Claude Code has no user-level disable switch; remove the server instead',
    )
  const entry: Record<string, unknown> = { ...asObject(input.extra), type: transport }
  if (transport === 'stdio') {
    if (typeof input.command !== 'string' || !input.command.trim())
      invalid('command', '要填命令', 'is required')
    entry.command = input.command.trim()
    if (input.args != null) {
      if (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== 'string'))
        invalid('args', '要是一列文字', 'must be a list of strings')
      entry.args = input.args
    } else entry.args = []
    if (typeof input.cwd === 'string' && input.cwd) entry.cwd = input.cwd
    const env = keepSecrets(stringMap(input.env), stringMap(previous.env))
    if (Object.keys(env).length) entry.env = env
  } else {
    let url: URL | null = null
    try {
      url = typeof input.url === 'string' ? new URL(input.url) : null
    } catch {}
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:'))
      invalid('url', '要是 http 或 https 地址', 'must be an http(s) URL')
    entry.url = input.url
    const headers = keepSecrets(stringMap(input.headers), stringMap(previous.headers))
    if (Object.keys(headers).length) entry.headers = headers
  }
  return entry
}

function writeMcpServers(
  expectedVersion: unknown,
  change: (servers: Record<string, unknown>) => void,
): HarnessMcpWriteResponse {
  if (typeof expectedVersion !== 'string')
    throw new HarnessConfigError(
      'invalidValue',
      text('缺少 expectedVersion', 'expectedVersion is required'),
    )
  const global = readGlobalConfig()
  const servers = { ...mcpServersOf(global) }
  if (mcpVersion(servers) !== expectedVersion)
    throw new HarnessConfigError(
      'versionConflict',
      text('MCP 配置已经变了，请重新读取', 'MCP config changed; reload it'),
    )
  change(servers)
  try {
    writeJsonObject(claudeGlobalConfigPath(), { ...global, mcpServers: servers }, 0o600)
  } catch (error) {
    fileError(error)
  }
  return { version: mcpVersion(servers), restartRequired: false }
}

export function upsertClaudeMcp(params: Record<string, unknown>): HarnessMcpWriteResponse {
  const server = asObject(params.server)
  const name = server.name
  if (typeof name !== 'string' || !MCP_NAME.test(name))
    invalid('name', '只能用字母、数字和 . _ -', 'may only contain letters, digits, . _ -')
  const previousName = typeof params.previousName === 'string' ? params.previousName : name
  return writeMcpServers(params.expectedVersion, (servers) => {
    if (previousName !== name && Object.hasOwn(servers, name))
      invalid('name', '已经有同名的服务', 'already exists')
    if (params.previousName != null && !Object.hasOwn(servers, previousName))
      throw new HarnessConfigError(
        'notFound',
        text(`没有 MCP 服务 ${previousName}`, `No MCP server ${previousName}`),
      )
    const entry = mcpEntry(server, asObject(servers[previousName]))
    if (previousName !== name) delete servers[previousName]
    servers[name] = entry
  })
}

export function removeClaudeMcp(params: Record<string, unknown>): HarnessMcpWriteResponse {
  const name = params.name
  return writeMcpServers(params.expectedVersion, (servers) => {
    if (typeof name !== 'string' || !Object.hasOwn(servers, name))
      throw new HarnessConfigError(
        'notFound',
        text(`没有 MCP 服务 ${String(name)}`, `No MCP server ${String(name)}`),
      )
    delete servers[name]
  })
}

// ---------- 指令文件：<配置目录>/CLAUDE.md ----------

export function readClaudeInstructions(): HarnessInstructionsInfo {
  const path = claudeInstructionsPath()
  let content: string | null
  try {
    content = readTextFile(path)
  } catch (error) {
    fileError(error)
  }
  return {
    path,
    fileName: 'CLAUDE.md',
    exists: content !== null,
    content: content ?? '',
    hash: content === null ? '' : contentHash(content),
    linkTarget: symlinkTarget(path),
    overriddenBy: null,
  }
}

export function writeClaudeInstructions(
  params: Record<string, unknown>,
): HarnessInstructionsWriteResponse {
  if (typeof params.content !== 'string') invalid('content', '要是文字', 'must be a string')
  if (typeof params.expectedHash !== 'string')
    throw new HarnessConfigError(
      'invalidValue',
      text('缺少 expectedHash', 'expectedHash is required'),
    )
  const current = readClaudeInstructions()
  if (current.hash !== params.expectedHash)
    throw new HarnessConfigError(
      'versionConflict',
      text('CLAUDE.md 已经变了，请重新读取', 'CLAUDE.md changed; reload it'),
    )
  try {
    // 统一模式下它是软链：写到软链指向的那份
    writeTextFileAtomic(current.path, params.content)
  } catch (error) {
    fileError(error)
  }
  return { hash: contentHash(params.content) }
}

// ---------- 入口 ----------

export interface HarnessConfigHost extends ProvidersHost {
  /** 当前可选的模型，给“默认模型”一项做下拉 */
  modelOptions(): HarnessSettingOption[]
  /** settings.json 里的默认模型或强度经这里改了：适配器重读 */
  defaultsChanged(): void
  /** 现有的 MCP OAuth（mcp-oauth.mts）：开始授权，回授权链接；结局经 complete 报 */
  mcpLogin(
    name: string,
    complete: (result: { success: boolean; error: string | null }) => void,
  ): Promise<{ authorizationUrl: string }>
}

// 授权链接里回调地址的端口：远程设备上客户端要把本机的同一端口转发过去
function callbackPort(authorizationUrl: string): number | null {
  try {
    const redirect = new URL(new URL(authorizationUrl).searchParams.get('redirect_uri') ?? '')
    if (redirect.hostname !== '127.0.0.1' && redirect.hostname !== 'localhost') return null
    return redirect.port ? Number(redirect.port) : null
  } catch {
    return null
  }
}

export class ClaudeHarnessConfig {
  private readonly host: HarnessConfigHost
  readonly providers: ClaudeProviders

  constructor(host: HarnessConfigHost) {
    this.host = host
    this.providers = new ClaudeProviders(host)
  }

  private changed(part: HarnessConfigChangedNotification['part']): void {
    this.host.broadcast(HARNESS_CONFIG_NOTIFICATION.changed, { harness: CLAUDE_HARNESS_ID, part })
  }

  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case HARNESS_CONFIG_METHOD.configRead:
        return readClaudeConfig(this.host.modelOptions())
      case HARNESS_CONFIG_METHOD.configWrite: {
        const { defaultsChanged, ...result } = writeClaudeConfig(
          params.edits,
          params.expectedVersion,
          this.host.modelOptions(),
        )
        if (defaultsChanged) this.host.defaultsChanged()
        this.changed('config')
        return result
      }
      case HARNESS_CONFIG_METHOD.configAction:
        throw new HarnessConfigError(
          'notFound',
          text('没有这个动作', 'Unknown action'),
          String(params.actionId),
        )
      case HARNESS_CONFIG_METHOD.providersRead:
        return this.providers.read()
      case HARNESS_CONFIG_METHOD.providersUpsert:
        return this.providers.upsert(params)
      case HARNESS_CONFIG_METHOD.providersRemove:
        return this.providers.remove(params)
      case HARNESS_CONFIG_METHOD.providersActivate:
        return this.providers.activate(params)
      case HARNESS_CONFIG_METHOD.authStart:
        return this.providers.authStart(params)
      case HARNESS_CONFIG_METHOD.authContinue:
        return this.providers.authContinue(params)
      case HARNESS_CONFIG_METHOD.authCancel:
        return this.providers.authCancel(params)
      case HARNESS_CONFIG_METHOD.authLogout:
        return this.providers.authLogout(params)
      case HARNESS_CONFIG_METHOD.mcpRead:
        return readClaudeMcp()
      case HARNESS_CONFIG_METHOD.mcpUpsert: {
        const result = upsertClaudeMcp(params)
        this.changed('mcp')
        return result
      }
      case HARNESS_CONFIG_METHOD.mcpRemove: {
        const result = removeClaudeMcp(params)
        this.changed('mcp')
        return result
      }
      case HARNESS_CONFIG_METHOD.mcpLogin:
        return this.mcpLogin(params)
      case HARNESS_CONFIG_METHOD.instructionsRead:
        return readClaudeInstructions()
      case HARNESS_CONFIG_METHOD.instructionsWrite: {
        const result = writeClaudeInstructions(params)
        this.changed('instructions')
        return result
      }
      default:
        throw new ProtocolError(-32601, `未知方法: ${method}`)
    }
  }

  private async mcpLogin(params: Record<string, unknown>): Promise<HarnessAuthStartResponse> {
    const name = params.name
    if (typeof name !== 'string' || !readClaudeMcp().servers.some((server) => server.name === name))
      throw new HarnessConfigError(
        'notFound',
        text(`没有 MCP 服务 ${String(name)}`, `No MCP server ${String(name)}`),
        'name',
      )
    const attemptId = newId()
    let authorizationUrl: string
    try {
      ;({ authorizationUrl } = await this.host.mcpLogin(name, (result) => {
        const step: HarnessAuthStep = result.success
          ? { kind: 'done', auth: { signedIn: true, kind: 'oauth', label: null } }
          : {
              kind: 'failed',
              message: text(
                `MCP 授权失败：${result.error ?? ''}`,
                `MCP sign-in failed: ${result.error ?? ''}`,
              ),
            }
        this.host.broadcast(HARNESS_CONFIG_NOTIFICATION.authUpdated, {
          harness: CLAUDE_HARNESS_ID,
          attemptId,
          mcpServer: name,
          step,
        })
      }))
    } catch (error) {
      if (error instanceof HarnessConfigError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new HarnessConfigError(
        'authFailed',
        text(`MCP 授权没能开始：${message}`, `MCP sign-in could not start: ${message}`),
        'name',
      )
    }
    return {
      attemptId,
      step: {
        kind: 'openUrl',
        url: authorizationUrl,
        callbackPort: callbackPort(authorizationUrl),
        message: text(
          '在浏览器里打开链接授权，完成后会自动回到设备上。',
          'Open the link to authorize; the device receives the callback automatically.',
        ),
      },
    }
  }

  close(): void {
    this.providers.close()
  }
}
