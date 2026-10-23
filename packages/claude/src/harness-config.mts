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
    id: 'models',
    title: text('模型', 'Models'),
    description: text(
      '环境变量类的项写在 settings.json 的 env 里，会盖过设备设置里同名的环境变量。',
      'Environment-variable items are written to the env block of settings.json and take precedence over the same variables in device settings.',
    ),
  },
  { id: 'context', title: text('上下文窗口', 'Context window'), description: null },
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
  {
    id: 'telemetry',
    title: text('遥测与上报', 'Telemetry and reporting'),
    description: text(
      '控制 Claude Code 发给 Anthropic 的使用统计、错误报告和反馈。写在 settings.json 的 env 里。',
      'Controls the usage statistics, error reports and feedback Claude Code sends to Anthropic. Written to the env block of settings.json.',
    ),
  },
  {
    id: 'otel',
    title: text('OpenTelemetry 上报', 'OpenTelemetry export'),
    description: text(
      '把用量指标和事件发到你自己的 OpenTelemetry 收集端，与发给 Anthropic 的遥测无关。',
      'Sends usage metrics and events to your own OpenTelemetry collector. Separate from telemetry sent to Anthropic.',
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

// ---------- settings.json 的 env 里的项 ----------
// CLI 启动时把 settings.json 的 env 整个并进自己的环境（盖过启动时带进来的同名变量），之后才读这些变量，
// 所以改了都是新开的会话才生效。env 里的值都是字符串，读写时按下面的写法换算：
// - presence：CLI 只看有没有值，"0" 也算开（DISABLE_TELEMETRY 这几个）。开写 "1"，关就删掉这个键
// - flag：CLI 只认 1/true/yes/on 为开。开写 "1"，关就删掉（不写 "0"，免得被只看有没有值的地方当成开）
// - integer：十进制字符串；读到不是整数的写法（比如新版 CLI 认的 200k）不显示，原样留在文件里
// - string：原样；写空串等于删掉
// - secret：只写不读回，读到的是 {set}；写空串表示不改
type EnvCodec = 'presence' | 'flag' | 'integer' | 'string' | 'secret'

const ENV_CODECS = new Map<string, EnvCodec>()
const TRUTHY = new Set(['1', 'true', 'yes', 'on'])

type EnvSpecInput = Omit<SpecInput, 'key' | 'type'> & { type?: 'string' | 'enum' }

function envSpec(name: string, codec: EnvCodec, input: EnvSpecInput): HarnessSettingSpec {
  const key = `env.${name}`
  ENV_CODECS.set(key, codec)
  const flag = codec === 'presence' || codec === 'flag'
  const type = codec === 'string' ? (input.type ?? 'string') : flag ? 'boolean' : codec // integer、secret
  return spec({ ...(flag ? { default: false } : {}), ...input, key, type })
}

/** settings.json 里存的值换成给界面的值；undefined 表示当作没写 */
function decodeValue(item: HarnessSettingSpec, raw: unknown): HarnessSettingValue | undefined {
  if (raw === undefined) return undefined
  if (item.key.startsWith('enabledPlugins.')) return raw !== false
  const codec = ENV_CODECS.get(item.key)
  if (!codec) return raw as HarnessSettingValue
  if (typeof raw !== 'string') return undefined
  switch (codec) {
    case 'presence':
      return raw !== ''
    case 'flag':
      return TRUTHY.has(raw.trim().toLowerCase())
    case 'integer':
      return /^[+-]?\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined
    case 'secret':
      return { set: raw !== '' }
    default:
      return raw
  }
}

/** 校验过的值换成写进 settings.json 的值；undefined 表示删掉这个键 */
function encodeValue(key: string, value: unknown): unknown {
  const codec = ENV_CODECS.get(key)
  if (!codec || value === undefined) return value
  switch (codec) {
    case 'presence':
    case 'flag':
      return value === true ? '1' : undefined
    case 'integer':
      return String(value)
    default:
      return value === '' ? undefined : value
  }
}

// 别名（opus、sonnet、haiku、fable）实际指向哪个型号。Litch 只改写凭据和网关地址（ANTHROPIC_API_KEY、
// ANTHROPIC_AUTH_TOKEN、ANTHROPIC_BASE_URL），不碰这几个，所以不会和 provider 的选择打架
function aliasModelSpec(alias: string, name: string): HarnessSettingSpec {
  const title = alias.charAt(0).toUpperCase() + alias.slice(1)
  return envSpec(name, 'string', {
    group: 'models',
    title: text(`${title} 别名对应的模型`, `Model for the ${alias} alias`),
    description: text(
      `选 ${alias} 时实际用的模型 ID。走网关或第三方服务、型号名和官方不同时才需要填。`,
      `Model ID used when ${alias} is selected. Only needed when a gateway or third-party provider uses different model names.`,
    ),
    placeholder: `claude-${alias}-…`,
  })
}

const MODEL_SPECS: HarnessSettingSpec[] = [
  spec({
    key: 'availableModels',
    group: 'models',
    type: 'stringList',
    title: text('可选的模型', 'Allowed models'),
    description: text(
      '只允许选这些模型，可写别名（opus 放行所有 Opus 版本）、版本前缀或完整型号。不写表示都能选；写成空列表就只剩默认模型。Litch 的模型列表也跟着它过滤。',
      'Only these models can be selected: aliases (opus allows every Opus version), version prefixes or full model IDs. Unset allows all; an empty list leaves only the default model. Litch’s model list follows it too.',
    ),
  }),
  aliasModelSpec('opus', 'ANTHROPIC_DEFAULT_OPUS_MODEL'),
  aliasModelSpec('sonnet', 'ANTHROPIC_DEFAULT_SONNET_MODEL'),
  aliasModelSpec('haiku', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'),
  aliasModelSpec('fable', 'ANTHROPIC_DEFAULT_FABLE_MODEL'),
  envSpec('CLAUDE_CODE_SUBAGENT_MODEL', 'string', {
    group: 'models',
    title: text('子代理用的模型', 'Subagent model'),
    description: text(
      '没有自己指定模型的子代理用它；写 inherit 或不写表示跟主会话用同一个模型。',
      'Used by subagents that do not specify a model. inherit or unset uses the main session’s model.',
    ),
    placeholder: 'sonnet',
  }),
  spec({
    key: 'modelSettings',
    group: 'models',
    type: 'json',
    title: text('按模型的设置', 'Per-model settings'),
    description: text(
      '键是模型名，值里可写 effortLevel（推理强度）、maxEffortLevel（强度上限）、autoCompactWindow（自动压缩窗口），例如 {"claude-opus-5-5": {"effortLevel": "high"}}。Litch 的会话按会话自己选的强度。',
      'Keyed by model name; values may set effortLevel, maxEffortLevel and autoCompactWindow, e.g. {"claude-opus-5-5": {"effortLevel": "high"}}. Litch sessions use the effort chosen for the session.',
    ),
  }),
]

// 自动压缩窗口的范围（CLI 的设置说明：100000 到 1000000 个 token）
const COMPACT_WINDOW = { minimum: 100_000, maximum: 1_000_000 }

const CONTEXT_SPECS: HarnessSettingSpec[] = [
  envSpec('CLAUDE_CODE_DISABLE_1M_CONTEXT', 'flag', {
    group: 'context',
    title: text('关闭 1M 上下文', 'Disable 1M context'),
    description: text(
      '模型名带 [1m] 后缀（例如 opus[1m]）才用 1M 上下文。开了这一项，模型列表里不再有 [1m] 的型号，上下文限在 200K。',
      'A model uses 1M context only with the [1m] suffix (e.g. opus[1m]). When on, [1m] models are removed from the list and context is limited to 200K.',
    ),
  }),
  envSpec('CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'integer', {
    group: 'context',
    title: text('自动压缩窗口（环境变量）', 'Auto-compact window (env)'),
    description: text(
      '上下文用到多少 token 时自动压缩，100000 到 1000000，超过模型的窗口按模型的算。设了它，下面的“自动压缩窗口”和按模型的设置都不起作用。',
      'Token count at which auto-compact kicks in, 100000 to 1000000, capped at the model window. When set, it overrides the auto-compact window below and per-model settings.',
    ),
    ...COMPACT_WINDOW,
  }),
  spec({
    key: 'autoCompactWindow',
    group: 'context',
    type: 'integer',
    title: text('自动压缩窗口', 'Auto-compact window'),
    description: text(
      '同上，写在设置里；按模型的设置（modelSettings）里写了的以那边为准。不写按模型自动定。',
      'Same as above, as a setting; per-model settings (modelSettings) take precedence. Unset picks a window per model.',
    ),
    ...COMPACT_WINDOW,
  }),
  envSpec('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'integer', {
    group: 'context',
    title: text('提前压缩（百分比）', 'Compact earlier (percent)'),
    description: text(
      '用到自动压缩窗口的百分之几就压缩，1 到 100。只能让压缩来得更早，不能推迟。',
      'Compact at this percentage (1–100) of the auto-compact window. Can only make compaction happen earlier.',
    ),
    minimum: 1,
    maximum: 100,
  }),
  envSpec('CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'integer', {
    group: 'context',
    title: text('单次输出上限（token）', 'Max output tokens'),
    description: text(
      '一次回答最多输出多少 token。默认值和上限因模型而异，超过上限按上限算；调大会让留给上下文的空间变小、更早压缩。',
      'Maximum output tokens per request. Defaults and caps vary by model; values above the cap are lowered. Larger values leave less room before auto-compact.',
    ),
    minimum: 1,
  }),
]

const TELEMETRY_SPECS: HarnessSettingSpec[] = [
  envSpec('DISABLE_TELEMETRY', 'presence', {
    group: 'telemetry',
    title: text('关闭使用统计', 'Disable telemetry'),
    description: text(
      '不向 Anthropic 发使用统计，也不再弹会话质量问卷。',
      'Stops sending usage statistics to Anthropic and turns off session quality surveys.',
    ),
  }),
  envSpec('DO_NOT_TRACK', 'flag', {
    group: 'telemetry',
    title: text('请勿跟踪（DO_NOT_TRACK）', 'Do not track (DO_NOT_TRACK)'),
    description: text(
      '通用的隐私开关，Claude Code 按关闭使用统计处理。',
      'A generic privacy opt-out; Claude Code treats it like disabling telemetry.',
    ),
  }),
  envSpec('DISABLE_ERROR_REPORTING', 'presence', {
    group: 'telemetry',
    title: text('关闭错误报告', 'Disable error reporting'),
    description: text(
      '出错时不向 Anthropic 发错误报告。',
      'Stops sending error reports to Anthropic.',
    ),
  }),
  envSpec('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'presence', {
    group: 'telemetry',
    title: text('关闭所有非必要的网络请求', 'Disable nonessential traffic'),
    description: text(
      '一次关掉使用统计、错误报告、/feedback、自动更新、版本说明和特性开关的拉取。',
      'Turns off telemetry, error reporting, /feedback, auto-updates, release notes and feature-flag fetching at once.',
    ),
  }),
  envSpec('CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY', 'flag', {
    group: 'telemetry',
    title: text('关闭会话质量问卷', 'Disable feedback surveys'),
    description: text(
      '不再弹“Claude 做得怎么样？”的问卷。',
      'Turns off the “How is Claude doing?” session quality surveys.',
    ),
  }),
  envSpec('DISABLE_FEEDBACK_COMMAND', 'flag', {
    group: 'telemetry',
    title: text('关闭 /feedback 命令', 'Disable /feedback'),
    description: text(
      '不能再用 /feedback 向 Anthropic 提交反馈。',
      'Turns off the /feedback command for sending feedback to Anthropic.',
    ),
  }),
]

const OTEL_SPECS: HarnessSettingSpec[] = [
  envSpec('CLAUDE_CODE_ENABLE_TELEMETRY', 'flag', {
    group: 'otel',
    title: text('开启 OpenTelemetry 上报', 'Enable OpenTelemetry'),
    description: text(
      '开了以后才按下面的设置导出指标和事件。',
      'Metrics and events are exported with the settings below only when this is on.',
    ),
  }),
  envSpec('OTEL_METRICS_EXPORTER', 'string', {
    group: 'otel',
    type: 'enum',
    title: text('指标导出方式', 'Metrics exporter'),
    description: text(
      '可以写多个，用逗号隔开，例如 otlp,console。',
      'Several can be combined with commas, e.g. otlp,console.',
    ),
    options: [
      { value: 'otlp', title: text('OTLP', 'OTLP') },
      { value: 'prometheus', title: text('Prometheus', 'Prometheus') },
      { value: 'console', title: text('打印到控制台', 'Console') },
      { value: 'none', title: text('不导出', 'None') },
    ],
    allowCustom: true,
  }),
  envSpec('OTEL_LOGS_EXPORTER', 'string', {
    group: 'otel',
    type: 'enum',
    title: text('事件导出方式', 'Events exporter'),
    description: text('可以写多个，用逗号隔开。', 'Several can be combined with commas.'),
    options: [
      { value: 'otlp', title: text('OTLP', 'OTLP') },
      { value: 'console', title: text('打印到控制台', 'Console') },
      { value: 'none', title: text('不导出', 'None') },
    ],
    allowCustom: true,
  }),
  envSpec('OTEL_EXPORTER_OTLP_PROTOCOL', 'string', {
    group: 'otel',
    type: 'enum',
    title: text('OTLP 协议', 'OTLP protocol'),
    options: [
      { value: 'grpc', title: text('gRPC', 'gRPC') },
      { value: 'http/protobuf', title: text('HTTP（protobuf）', 'HTTP (protobuf)') },
      { value: 'http/json', title: text('HTTP（JSON）', 'HTTP (JSON)') },
    ],
  }),
  envSpec('OTEL_EXPORTER_OTLP_ENDPOINT', 'string', {
    group: 'otel',
    title: text('OTLP 地址', 'OTLP endpoint'),
    placeholder: 'http://localhost:4317',
  }),
  envSpec('OTEL_EXPORTER_OTLP_HEADERS', 'secret', {
    group: 'otel',
    title: text('OTLP 请求头', 'OTLP headers'),
    description: text(
      '常用来放令牌，形如 Authorization=Bearer 令牌，多个用逗号隔开。只能写入，不会读回。',
      'Usually carries a token, e.g. Authorization=Bearer token; separate several with commas. Write-only.',
    ),
  }),
  spec({
    key: 'otelHeadersHelper',
    group: 'otel',
    type: 'path',
    title: text('请求头脚本', 'Headers helper script'),
    description: text(
      '设备上的一个脚本，输出 JSON 格式的请求头，适合会过期的令牌。',
      'A script on the device that prints the headers as JSON, for tokens that expire.',
    ),
  }),
  envSpec('OTEL_METRIC_EXPORT_INTERVAL', 'integer', {
    group: 'otel',
    title: text('指标导出间隔（毫秒）', 'Metrics export interval (ms)'),
    default: 60_000,
    minimum: 1,
  }),
  envSpec('OTEL_LOGS_EXPORT_INTERVAL', 'integer', {
    group: 'otel',
    title: text('事件导出间隔（毫秒）', 'Events export interval (ms)'),
    default: 5_000,
    minimum: 1,
  }),
  envSpec('OTEL_LOG_USER_PROMPTS', 'flag', {
    group: 'otel',
    title: text('事件里带上提示词原文', 'Include prompt text'),
    description: text(
      '关着时只记提示词的长度，原文显示为 <REDACTED>。',
      'When off, only the prompt length is recorded and the text shows as <REDACTED>.',
    ),
  }),
  envSpec('OTEL_LOG_TOOL_DETAILS', 'flag', {
    group: 'otel',
    title: text('事件里带上工具细节', 'Include tool details'),
    description: text(
      '记下工具调用的参数和出错信息，以及 MCP 服务和工具的名字。',
      'Records tool call arguments and errors, plus MCP server and tool names.',
    ),
  }),
]

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
      group: 'context',
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
    envSpec('DISABLE_AUTOUPDATER', 'flag', {
      group: 'advanced',
      title: text('关闭自动更新', 'Disable auto-updates'),
      description: text(
        '不在后台自动更新 Claude Code；手动运行 claude update 照样能更新，仍按上面的更新通道。',
        'Stops background auto-updates. Running claude update by hand still works and follows the update channel above.',
      ),
    }),
    ...MODEL_SPECS,
    ...CONTEXT_SPECS,
    ...TELEMETRY_SPECS,
    ...OTEL_SPECS,
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
    const value = decodeValue(item, getAtPath(settings, path))
    if (value !== undefined) values[item.key] = value
    const locked = getAtPath(managed, path)
    if (locked !== undefined)
      overridden[item.key] = {
        value: decodeValue(item, locked) ?? (locked as HarnessSettingValue),
        by: MANAGED,
      }
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
    case 'secret':
      if (typeof value !== 'string') invalid(key, '要是文字', 'must be a string')
      return value
    case 'path':
      if (typeof value !== 'string' || !value.trim()) invalid(key, '要填路径', 'must be a path')
      return value.trim()
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
    // 密钥读不回来，界面上没改时会带空串回来：表示不动
    if (item.type === 'secret' && raw === '') continue
    let value: unknown
    if (raw === null || raw === undefined) {
      if (item.clearable === false) invalid(key, '不能清掉', 'cannot be cleared')
      value = undefined
    } else value = validateValue(item, raw)
    if (key === 'model' && typeof value === 'string') value = settingsModelValue(value) ?? undefined
    if (key === 'model' || key === 'effortLevel') defaultsChanged = true
    setAtPath(next, path, encodeValue(key, value))
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
      case HARNESS_CONFIG_METHOD.providersDiscoverModels:
        return this.providers.discoverModels(params)
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
