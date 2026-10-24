// Claude Code 的账号与供应商。
//
// - 账号（anthropic）只有一个：CLI 自己存的那份登录（claude.ai 订阅或 Console，钥匙串或 .credentials.json），
//   另可放一个 `claude setup-token` 生成的长期令牌（存在下面的密钥文件里）。
// - 供应商可以有多个，用户自己加：Anthropic API key（官方地址或自定的地址，x-api-key）和 Anthropic 兼容网关
//   （地址、鉴权头、手填的型号清单、小模型映射、额外请求头）。定义记在适配器的 config.json（litch_providers），
//   密钥和额外请求头（常带令牌）只在 provider-secrets.json（0600，不原样读回）。
// - native：用户自己在 settings.json、启动环境里配的凭据或网关（Claude Code 自己的配置），只读，原样交给 CLI。
//
// 不同供应商的型号放进同一个目录，型号 ID 写成 `<供应商>/<型号>`，按第一个 `/` 切；不带已知前缀的
// （以前的会话、别的客户端给的）算 plainProvider()。会话按自己型号的供应商起 CLI，同时跑互不影响：
// CLI 只按进程环境和设置文件选凭据，用 API key 不会登出或改写账号的凭据。
import { createHash } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { claudeSettingsPath, readJsonObject, writeJsonObject } from './claude-native-files.mjs'
import { readConfigFile, writeConfigFile } from './config-store.mjs'
import { adapterHome } from './util.mjs'

export const PROVIDER_CONFIG_KEY = 'litch_providers'

export const ACCOUNT_PROVIDER = 'anthropic'
export const NATIVE_PROVIDER = 'native'
const RESERVED_IDS = new Set([ACCOUNT_PROVIDER, NATIVE_PROVIDER])

export const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

export type ProviderKind = 'apiKey' | 'gateway'
export type ProviderAuthHeader = 'bearer' | 'apiKey'

export interface ProviderModel {
  id: string
  title: string | null
  /**
   * 上下文窗口（token）；null 是没填，CLI 按它自己的规则（认不出的型号是 200K）。
   * 起 CLI 时作为 CLAUDE_CODE_MAX_CONTEXT_TOKENS 给，CLI 只对它不认识的型号认这个变量
   */
  contextWindow: number | null
}

export const CONTEXT_WINDOW_MIN = 1_000
export const CONTEXT_WINDOW_MAX = 100_000_000

/** 能用的上下文窗口：范围内的整数，别的都是 null */
export function contextWindowValue(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= CONTEXT_WINDOW_MIN &&
    value <= CONTEXT_WINDOW_MAX
    ? value
    : null
}

export interface ProviderDefinition {
  kind: ProviderKind
  title: string | null
  /** apiKey：null 是官方地址；gateway：必填 */
  baseUrl: string | null
  /** apiKey 一律 x-api-key */
  authHeader: ProviderAuthHeader
  /** gateway：手填（或从网关拉来勾选）的型号；apiKey 的型号由 CLI 按这把 key 列 */
  models: ProviderModel[]
  /** gateway：CLI 内部用小模型的请求（起标题、haiku 档）改用哪个；null 用会话所选的型号 */
  smallModel: string | null
}

export interface ProviderConfig {
  /** 上一次在任何会话（含新建页）里选的型号（`<供应商>/<型号>`）；新会话照它 */
  last: string | null
  providers: Record<string, ProviderDefinition>
  /**
   * 删掉的供应商 ID：会话的型号还带着这个前缀时认出是它、报“没有这个供应商”，不当成不带前缀的型号
   * 交给账号（网关的历史不能发到别家）。同名的重新加上就从这里去掉
   */
  removed: string[]
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseModels(value: unknown): ProviderModel[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const models: ProviderModel[] = []
  for (const raw of value) {
    const entry = asObject(raw)
    const id = optionalString(entry.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    models.push({
      id,
      title: optionalString(entry.title),
      contextWindow: contextWindowValue(entry.contextWindow),
    })
  }
  return models
}

export function parseProviderConfig(value: unknown): ProviderConfig {
  const record = asObject(value)
  const providers: Record<string, ProviderDefinition> = {}
  for (const [id, raw] of Object.entries(asObject(record.providers))) {
    const entry = asObject(raw)
    if (!PROVIDER_ID_PATTERN.test(id) || RESERVED_IDS.has(id)) continue
    const kind: ProviderKind = entry.kind === 'gateway' ? 'gateway' : 'apiKey'
    const baseUrl = optionalString(entry.baseUrl)
    if (kind === 'gateway' && !baseUrl) continue
    providers[id] = {
      kind,
      title: optionalString(entry.title),
      baseUrl,
      authHeader: kind === 'gateway' && entry.authHeader === 'apiKey' ? 'apiKey' : 'bearer',
      models: kind === 'gateway' ? parseModels(entry.models) : [],
      smallModel: kind === 'gateway' ? optionalString(entry.smallModel) : null,
    }
    if (kind === 'apiKey') providers[id].authHeader = 'apiKey'
  }
  const removed = Array.isArray(record.removed)
    ? [
        ...new Set(
          record.removed.filter(
            (id): id is string =>
              typeof id === 'string' &&
              PROVIDER_ID_PATTERN.test(id) &&
              !Object.hasOwn(providers, id),
          ),
        ),
      ]
    : []
  return { last: optionalString(record.last), providers, removed }
}

export function providerConfigPath(): string {
  return join(adapterHome(), 'config.json')
}

export function readProviderConfig(path = providerConfigPath()): ProviderConfig {
  try {
    return parseProviderConfig(readConfigFile(path).values[PROVIDER_CONFIG_KEY])
  } catch {
    // config.json 坏了时服务本身起不来（启动时会报）；这里按没配过处理
    return { last: null, providers: {}, removed: [] }
  }
}

export function writeProviderConfig(config: ProviderConfig, path = providerConfigPath()): void {
  const { values, version } = readConfigFile(path)
  const providers = Object.fromEntries(
    Object.entries(config.providers).map(([id, provider]) => [
      id,
      {
        kind: provider.kind,
        ...(provider.title ? { title: provider.title } : {}),
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
        ...(provider.kind === 'gateway'
          ? {
              authHeader: provider.authHeader,
              models: provider.models.map((model) => ({
                id: model.id,
                ...(model.title ? { title: model.title } : {}),
                ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
              })),
              ...(provider.smallModel ? { smallModel: provider.smallModel } : {}),
            }
          : {}),
      },
    ]),
  )
  writeConfigFile(
    path,
    {
      ...values,
      [PROVIDER_CONFIG_KEY]: {
        ...(config.last ? { last: config.last } : {}),
        providers,
        ...(config.removed.length ? { removed: config.removed } : {}),
      },
    },
    version,
  )
}

/**
 * 供应商配置的版本：定义、各家密钥的有无（密钥本身不进）。上一次选的型号不算：每次建会话、换型号都会记，
 * 算进来的话开着的编辑框一保存就报冲突，模型目录也跟着重查
 */
export function providerConfigVersion(
  config = readProviderConfig(),
  secrets = readProviderSecrets(),
): string {
  const present = Object.keys(secrets).sort()
  return createHash('sha256')
    .update(JSON.stringify({ providers: config.providers, removed: config.removed, present }))
    .digest('hex')
    .slice(0, 16)
}

// ---------- 密钥 ----------

export function providerSecretsPath(): string {
  return join(adapterHome(), 'provider-secrets.json')
}

/** 各供应商的密钥（账号那一份是长期令牌）。文件坏了按没有处理，起 CLI 时那个供应商会报没填密钥 */
export function readProviderSecrets(path = providerSecretsPath()): Record<string, string> {
  try {
    const secrets: Record<string, string> = {}
    for (const [id, value] of Object.entries(asObject(readJsonObject(path).value.secrets)))
      if (typeof value === 'string' && value) secrets[id] = value
    return secrets
  } catch {
    return {}
  }
}

/** 网关的额外请求头（每行 `Name: Value`，原样进 ANTHROPIC_CUSTOM_HEADERS）在密钥文件里的键；ID 里没有 `:` */
export function providerHeadersKey(id: string): string {
  return `${id}:headers`
}

/** 改一个供应商的密钥（或 providerHeadersKey 那一项）；null 是删掉 */
export function writeProviderSecret(
  id: string,
  value: string | null,
  path = providerSecretsPath(),
): void {
  const secrets = readProviderSecrets(path)
  if (value) secrets[id] = value
  else delete secrets[id]
  writeJsonObject(path, { secrets }, 0o600)
  // 别人改过权限也收回来：这里面全是密钥
  chmodSync(path, 0o600)
}

/** 末四位，给界面看 */
export function secretLabel(value: string): string {
  return value.length > 8 ? `…${value.slice(-4)}` : '…'
}

// ---------- 型号 ID ----------

export interface ModelRef {
  provider: string
  model: string
}

function knownProvider(id: string, config: ProviderConfig): boolean {
  return RESERVED_IDS.has(id) || Object.hasOwn(config.providers, id)
}

/**
 * `<供应商>/<型号>` 切开（供应商 ID 区分大小写）。前缀是删掉的供应商时照样切开，起 CLI 时报没有这个供应商；
 * 前缀不是已知的供应商时整串是型号（只有一家能用时目录里的 ID 不带前缀，型号本身可能带 `/`），
 * 供应商按 plainProvider() 算
 */
export function splitModelRef(ref: string, config = readProviderConfig()): ModelRef {
  const slash = ref.indexOf('/')
  if (slash > 0) {
    const provider = ref.slice(0, slash)
    if (knownProvider(provider, config) || config.removed.includes(provider))
      return { provider, model: ref.slice(slash + 1) }
  }
  return { provider: plainProvider(), model: ref }
}

export function joinModelRef(provider: string, model: string): string {
  return `${provider}/${model}`
}

export function hasProviderPrefix(ref: string, config = readProviderConfig()): boolean {
  const slash = ref.indexOf('/')
  return slash > 0 && knownProvider(ref.slice(0, slash), config)
}

// ---------- 用户自己的配置（native） ----------

const CREDENTIAL_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_AWS_API_KEY',
] as const
const ENDPOINT_VARS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
] as const
const PLATFORM_VARS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
] as const
const MODEL_VARS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const
const HOST_VARS = ['CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR'] as const
/** CLI 对它认不出的型号用这个变量定上下文窗口（不设是 200K），自动压缩的门槛跟着它 */
export const CONTEXT_WINDOW_VAR = 'CLAUDE_CODE_MAX_CONTEXT_TOKENS'

/** 这几个变量里配了值，CLI 就不走账号：用户在 Claude Code 自己的配置里另配了凭据或模型服务 */
const NATIVE_MARKERS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  ...PLATFORM_VARS,
] as const

/**
 * 用户在启动环境或用户级 settings.json 里配了别的凭据、模型服务（不是账号）时，列出是哪几项；没有是空的。
 * 只看用户层：项目层跟着工作目录变，起 CLI 时照样会读。
 */
export function nativeOverrides(env: NodeJS.ProcessEnv = process.env): string[] {
  const found = new Set<string>()
  for (const name of NATIVE_MARKERS) if (env[name]) found.add(name)
  try {
    const settings = readJsonObject(claudeSettingsPath(env)).value
    for (const [name, value] of Object.entries(asObject(settings.env)))
      if ((NATIVE_MARKERS as readonly string[]).includes(name) && value) found.add(name)
    if (typeof settings.apiKeyHelper === 'string' && settings.apiKeyHelper)
      found.add('apiKeyHelper')
  } catch {}
  return [...found].sort()
}

/** 不带前缀的型号算哪家：用户自己另配了模型服务时是 native，否则就是账号 */
export function plainProvider(env: NodeJS.ProcessEnv = process.env): string {
  return nativeOverrides(env).length > 0 ? NATIVE_PROVIDER : ACCOUNT_PROVIDER
}

// ---------- 起 CLI 用的环境 ----------

export class ProviderUnavailableError extends Error {
  readonly provider: string
  constructor(provider: string, message: string) {
    super(message)
    this.provider = provider
  }
}

export interface ProviderLaunch {
  provider: string
  env: NodeJS.ProcessEnv
  /**
   * 要放进 CLI 命令行设置层（SDK 的 settings）的几项。账号：把用户设置里的凭据、地址、云厂商开关、
   * apiKeyHelper 置空（这一层高于用户、项目设置，空串等于没设）；别的供应商不放（这一层在进程参数里）
   */
  flagSettings: { env?: Record<string, string>; apiKeyHelper?: string } | null
  /** 托管模式：CLI 只认进程环境里的凭据、地址、型号映射和请求头，设置文件里的这些都不认 */
  managed: boolean
  /** 进程复用时比它：供应商、它的定义、密钥任一变了都要换进程 */
  scope: string
}

function scopeOf(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)
}

// 以前的版本把账号令牌、API key 放在 harness 环境的 LITCH_CLAUDE_* 里（不迁移，见 CHANGELOG）。
// 它们可能还留在设备设置里：别带进 CLI，工具的 shell 看得到进程环境
const LEGACY_SECRET_PREFIX = 'LITCH_CLAUDE_'

function without(base: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const drop = new Set(names)
  for (const [name, value] of Object.entries(base))
    if (!drop.has(name) && !name.startsWith(LEGACY_SECRET_PREFIX)) env[name] = value
  return env
}

/**
 * 按供应商算起 CLI 的环境。`model` 是会话要用的型号（网关的 opus、sonnet 档都指向它）。
 * 供应商不存在、没填密钥时抛 ProviderUnavailableError：绝不退回账号（CLI 只拿到地址没有凭据时
 * 会把账号的令牌发给那个地址）。
 */
export function providerLaunch(
  provider: string,
  model: string | null,
  base: NodeJS.ProcessEnv = process.env,
  config = readProviderConfig(),
  secrets = readProviderSecrets(),
): ProviderLaunch {
  if (provider === NATIVE_PROVIDER)
    return {
      provider,
      env: without(base, []),
      flagSettings: null,
      managed: false,
      scope: scopeOf([provider]),
    }
  if (provider === ACCOUNT_PROVIDER) {
    const token = secrets[ACCOUNT_PROVIDER]
    // 用户另配了模型服务时，型号映射（ANTHROPIC_DEFAULT_SONNET_MODEL 之类）是写给那一家的，账号不认；
    // 没另配时是用户给账号定的版本，照用
    const models = nativeOverrides(base).length > 0 ? MODEL_VARS : []
    const env = without(base, [
      ...CREDENTIAL_VARS.filter((name) => name !== 'CLAUDE_CODE_OAUTH_TOKEN'),
      ...ENDPOINT_VARS,
      ...PLATFORM_VARS,
      ...HOST_VARS,
      ...models,
    ])
    // 存了长期令牌用它；没存时外面带进来的 CLAUDE_CODE_OAUTH_TOKEN 也是账号凭据，留着
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token
    const blank = Object.fromEntries(
      [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        ...ENDPOINT_VARS,
        ...PLATFORM_VARS,
        ...models,
      ].map((name) => [name, '']),
    )
    return {
      provider,
      env,
      flagSettings: { env: blank, apiKeyHelper: '' },
      managed: false,
      scope: scopeOf([provider, token ? createHash('sha256').update(token).digest('hex') : null]),
    }
  }
  const definition = config.providers[provider]
  if (!definition)
    throw new ProviderUnavailableError(provider, `没有供应商 ${provider}，它可能已被删掉`)
  const secret = secrets[provider]
  if (!secret)
    throw new ProviderUnavailableError(
      provider,
      `供应商 ${definition.title ?? provider} 还没填密钥，在设备的 Claude Code 详情设置里填上`,
    )
  const headers =
    definition.kind === 'gateway' ? (secrets[providerHeadersKey(provider)] ?? null) : null
  const env = without(base, [
    ...CREDENTIAL_VARS,
    ...ENDPOINT_VARS,
    ...PLATFORM_VARS,
    ...MODEL_VARS,
    ...HOST_VARS,
    'ANTHROPIC_CUSTOM_HEADERS',
  ])
  env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
  if (definition.baseUrl) env.ANTHROPIC_BASE_URL = definition.baseUrl
  if (definition.authHeader === 'bearer') env.ANTHROPIC_AUTH_TOKEN = secret
  else env.ANTHROPIC_API_KEY = secret
  // 所选型号填了窗口就交给 CLI（盖过 harness 环境里的同名变量）；没填不动外面带进来的
  const window =
    definition.kind === 'gateway' && model
      ? (definition.models.find((entry) => entry.id === model)?.contextWindow ?? null)
      : null
  if (window) env[CONTEXT_WINDOW_VAR] = String(window)
  if (definition.kind === 'gateway') {
    if (model) {
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = model
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = model
    }
    const small = definition.smallModel ?? model
    if (small) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = small
    if (headers) env.ANTHROPIC_CUSTOM_HEADERS = headers
  }
  return {
    provider,
    env,
    flagSettings: null,
    managed: true,
    // 只算进了环境的几项：改显示名、型号清单不换进程。网关的型号也算，opus、sonnet 档的映射跟着它，
    // 进程起来之后改不了；所选型号的窗口也一样（改了老会话下一回合换进程就生效）
    scope: scopeOf([
      provider,
      definition.baseUrl,
      definition.authHeader,
      definition.kind === 'gateway' ? [model, definition.smallModel, window] : null,
      createHash('sha256')
        .update(`${secret}\n${headers ?? ''}`)
        .digest('hex'),
    ]),
  }
}

/** 按会话的供应商起 CLI；不知道供应商（以前的会话、一次性的查询）时按 plainProvider() 算 */
export function contextLaunch(
  provider: string | null | undefined,
  model: string | null,
): ProviderLaunch {
  return providerLaunch(provider ?? plainProvider(), model)
}

/** 把 launch 要放进命令行设置层的几项并进 SDK 的 settings（env 合在一起，已有的同名项让给 launch） */
export function withFlagSettings(
  settings: Record<string, unknown>,
  launch: ProviderLaunch,
): Record<string, unknown> {
  if (!launch.flagSettings) return settings
  const env = { ...asObject(settings.env), ...(launch.flagSettings.env ?? {}) }
  return {
    ...settings,
    ...(Object.keys(env).length ? { env } : {}),
    ...(launch.flagSettings.apiKeyHelper !== undefined
      ? { apiKeyHelper: launch.flagSettings.apiKeyHelper }
      : {}),
  }
}
