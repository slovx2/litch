// Claude Code 用哪种凭据：Anthropic 账号（claude.ai 订阅或 Console，凭据由 CLI 自己存）、API key、
// 自定义网关（ANTHROPIC_BASE_URL 加令牌）。三种互斥，当前选哪一种记在适配器自己的 config.json
// （overrides.litch_provider）；网关的地址也记在那里。
//
// 官方只认环境变量的密钥（API key、网关令牌、setup-token 生成的长期令牌）不归适配器存：客户端写进设备设置的
// `harness.claude-code.env`，设备服务起适配器时带进来，变量名都是 LITCH_ 开头的独立名字，切换时谁也不丢。
// 起 CLI 时（claudeChildEnv）按选择把它们换成 CLI 认的 ANTHROPIC_*，并清掉另外两种的变量；
// LITCH_ 的这几个本身不传给 CLI（不然模型跑的命令也看得见没在用的那几把 key）。
import { join } from 'node:path'
import { readConfigFile, writeConfigFile } from './config-store.mjs'
import { adapterHome } from './util.mjs'

export const PROVIDER_CONFIG_KEY = 'litch_provider'

/** 内置的两个 provider 的 id；自定义网关的 id 由用户起，不能和它们重 */
export const ACCOUNT_PROVIDER = 'anthropic'
export const API_KEY_PROVIDER = 'api-key'

export const ENV_API_KEY = 'LITCH_CLAUDE_API_KEY'
/** `claude setup-token` 生成的长期令牌，CLI 认 CLAUDE_CODE_OAUTH_TOKEN */
export const ENV_OAUTH_TOKEN = 'LITCH_CLAUDE_OAUTH_TOKEN'

export type GatewayAuthHeader = 'bearer' | 'apiKey'

export interface GatewayDefinition {
  title: string | null
  baseUrl: string
  /** bearer：令牌放进 ANTHROPIC_AUTH_TOKEN（Authorization: Bearer）；apiKey：放进 ANTHROPIC_API_KEY（x-api-key） */
  authHeader: GatewayAuthHeader
}

export interface ProviderSelection {
  /** 没选过是 null：环境原样交给 CLI，和以前一样 */
  active: string | null
  gateways: Record<string, GatewayDefinition>
}

export const GATEWAY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

/** 网关令牌的变量名：id 大写、- 换成 _ */
export function gatewayTokenEnv(id: string): string {
  return `LITCH_CLAUDE_GATEWAY_${id.toUpperCase().replace(/-/g, '_')}_TOKEN`
}

const PROVIDER_SECRET_ENV = /^LITCH_CLAUDE_(API_KEY|OAUTH_TOKEN|GATEWAY_[A-Z0-9_]+_TOKEN)$/

export function providerConfigPath(): string {
  return join(adapterHome(), 'config.json')
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function parseProviderSelection(value: unknown): ProviderSelection {
  const record = asObject(value)
  const gateways: Record<string, GatewayDefinition> = {}
  for (const [id, raw] of Object.entries(asObject(record.gateways))) {
    const entry = asObject(raw)
    if (!GATEWAY_ID_PATTERN.test(id) || typeof entry.baseUrl !== 'string') continue
    gateways[id] = {
      title: typeof entry.title === 'string' && entry.title ? entry.title : null,
      baseUrl: entry.baseUrl,
      authHeader: entry.authHeader === 'apiKey' ? 'apiKey' : 'bearer',
    }
  }
  const active =
    typeof record.active === 'string' &&
    (record.active === ACCOUNT_PROVIDER ||
      record.active === API_KEY_PROVIDER ||
      Object.hasOwn(gateways, record.active))
      ? record.active
      : null
  return { active, gateways }
}

export function readProviderSelection(path = providerConfigPath()): ProviderSelection {
  try {
    return parseProviderSelection(readConfigFile(path).values[PROVIDER_CONFIG_KEY])
  } catch {
    // 配置文件坏了时服务本身起不来（server 启动时会报）；这里不再抛，按没选过处理
    return { active: null, gateways: {} }
  }
}

export function writeProviderSelection(
  selection: ProviderSelection,
  path = providerConfigPath(),
): void {
  const { values } = readConfigFile(path)
  const gateways = Object.fromEntries(
    Object.entries(selection.gateways).map(([id, gateway]) => [
      id,
      {
        ...(gateway.title ? { title: gateway.title } : {}),
        baseUrl: gateway.baseUrl,
        authHeader: gateway.authHeader,
      },
    ]),
  )
  writeConfigFile(
    path,
    {
      ...values,
      [PROVIDER_CONFIG_KEY]: {
        ...(selection.active ? { active: selection.active } : {}),
        gateways,
      },
    },
    null,
  )
}

const CREDENTIAL_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const

/**
 * 按选的 provider 改写给 CLI 的环境。`provider` 给了就按它算（登录、查状态时要按账号算），
 * 不给就按记下的选择。没选过时只去掉 LITCH_ 的密钥变量，其余原样。
 */
export function applyProviderEnv(
  base: NodeJS.ProcessEnv,
  selection: ProviderSelection,
  provider: string | null = selection.active,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(base))
    if (!PROVIDER_SECRET_ENV.test(name)) env[name] = value
  if (provider === null) return env
  const set = (name: (typeof CREDENTIAL_ENV)[number], value: string | undefined) => {
    for (const other of CREDENTIAL_ENV) if (other !== name) delete env[other]
    if (value) env[name] = value
    else delete env[name]
  }
  if (provider === ACCOUNT_PROVIDER) {
    const token = base[ENV_OAUTH_TOKEN]
    if (token) set('CLAUDE_CODE_OAUTH_TOKEN', token)
    else {
      // 没有长期令牌：外面带进来的 CLAUDE_CODE_OAUTH_TOKEN 也是账号凭据，留着
      for (const other of CREDENTIAL_ENV) if (other !== 'CLAUDE_CODE_OAUTH_TOKEN') delete env[other]
    }
    return env
  }
  if (provider === API_KEY_PROVIDER) {
    set('ANTHROPIC_API_KEY', base[ENV_API_KEY])
    return env
  }
  const gateway = selection.gateways[provider]
  if (!gateway) return env
  const token = base[gatewayTokenEnv(provider)]
  set(gateway.authHeader === 'apiKey' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN', token)
  env.ANTHROPIC_BASE_URL = gateway.baseUrl
  return env
}

/** 起 Claude Code CLI 用的环境：按当前选择注入凭据 */
export function claudeChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return applyProviderEnv(base, readProviderSelection())
}
