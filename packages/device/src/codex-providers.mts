// 原生 codex 的 provider 与账号（litch/harness/providers/*、auth/*）。
//   - provider 就是 config.toml 的 `model_providers.<id>`，当前在用的是 `model_provider`（不写是 openai）。
//     codex 自带的 openai、ollama、lmstudio、amazon-bedrock、amazon-bedrock-runtime 是保留的名字，不能自定义
//     （上游 config_toml.rs 的 RESERVED_MODEL_PROVIDER_IDS）；Bedrock 这次不做，不列。
//   - openai 的登录走 codex 自己的 account/*：ChatGPT 浏览器登录（account/login/start type chatgpt，codex 在设备的
//     127.0.0.1 上起登录服务，端口从授权链接的 redirect_uri 里取，实测是 1455）、设备码（chatgptDeviceCode）、
//     API key（apiKey）。凭据由 codex 自己存（auth.json 或钥匙串）。同一时刻只能有一次登录，新开的会把进行中的取消（实测）。
//   - 自定义 provider（OpenAI 兼容）的 key 只认环境变量：env_key 指定变量名，客户端写进设备设置的
//     harness.codex.env、重启 codex。写定义时 requires_openai_auth 默认 false，ChatGPT 的凭据不动，两者并存。

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  HarnessAuthMethod,
  HarnessProvider,
  HarnessProviderAuthState,
  HarnessProvidersReadResponse,
  HarnessProviderTemplate,
  HarnessSettingSpec,
  HarnessSettingValue,
} from '../../protocol/src/harness-config.mjs'
import { type Ask, type CodexSnapshot, readSnapshot, segment } from './codex-config-io.mjs'
import { text } from './harness-config.mjs'
import { isObject } from './wire.mjs'

export const OPENAI = 'openai'
/** codex 自带、不能自定义的名字 */
export const RESERVED = new Set([
  OPENAI,
  'ollama',
  'lmstudio',
  'amazon-bedrock',
  'amazon-bedrock-runtime',
])
/** 本机的开源模型服务：自带，不用登录，可以切过去 */
const LOCAL = [
  { id: 'ollama', title: 'Ollama' },
  { id: 'lmstudio', title: 'LM Studio' },
]

export const TEMPLATE = 'openaiCompatible'
export const METHOD = {
  chatgpt: 'chatgpt',
  deviceCode: 'chatgptDeviceCode',
  apiKey: 'apiKey',
  env: 'env',
} as const

const field = (
  key: string,
  type: HarnessSettingSpec['type'],
  title: [string, string],
  more: Partial<HarnessSettingSpec> = {},
): HarnessSettingSpec => ({
  key,
  group: 'provider',
  type,
  title: text(...title),
  description: null,
  default: null,
  effect: 'newSession',
  ...more,
})

/** 自定义 provider 的定义里我们认的字段；别的字段（http_headers、query_params……）写的时候原样留着 */
export const TEMPLATE_FIELDS: HarnessSettingSpec[] = [
  field('name', 'string', ['名字', 'Name'], { clearable: false, placeholder: 'My Gateway' }),
  field('base_url', 'string', ['接口地址', 'Base URL'], { placeholder: 'https://example.com/v1' }),
  field('wire_api', 'enum', ['接口类型', 'Wire API'], {
    default: 'responses',
    options: [{ value: 'responses', title: text('Responses 接口', 'Responses API') }],
  }),
  field('env_key', 'string', ['API key 的环境变量名', 'API key environment variable'], {
    description: text(
      'codex 从这个环境变量里读 key；key 本身填在设备设置里，改完要重启 Codex',
      'codex reads the key from this variable; set it in device settings and restart Codex',
    ),
    placeholder: 'MY_GATEWAY_API_KEY',
  }),
  field('env_key_instructions', 'string', ['没有 key 时的提示', 'Missing key hint']),
  field(
    'requires_openai_auth',
    'boolean',
    ['用 ChatGPT 或 OpenAI 的登录', 'Use the OpenAI login'],
    {
      default: false,
    },
  ),
]

const TEMPLATES: HarnessProviderTemplate[] = [
  {
    id: TEMPLATE,
    title: text('OpenAI 兼容的接口', 'OpenAI-compatible API'),
    description: text(
      '接一个说 Responses 接口的网关或第三方服务，key 从环境变量读',
      'A gateway or third-party service speaking the Responses API; the key comes from an environment variable',
    ),
    fields: TEMPLATE_FIELDS,
  },
]

const NONE: HarnessProviderAuthState = { signedIn: false, kind: 'none', label: null }

/** JWT 中间那一段里的声明（只取邮箱、套餐这种给人看的，不验签） */
function claims(token: unknown): Record<string, unknown> {
  if (typeof token !== 'string') return {}
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
    return isObject(payload) ? payload : {}
  } catch {
    return {}
  }
}

/**
 * 在用的 provider 不用 OpenAI 的登录（requires_openai_auth = false）时，account/read 不报账号（上游
 * account_processor：这时 account 为空）。ChatGPT 的登录其实还在，只是看不到：凭据存在文件里
 * （cli_auth_credentials_store = file，默认）就从 auth.json 看一眼是哪种、谁的；只取类型、邮箱、套餐，
 * 令牌本身不碰。存在钥匙串里的看不到，照实说不知道
 */
async function storedAuth(home: string | null): Promise<HarnessProviderAuthState> {
  const unknown: HarnessProviderAuthState = {
    ...NONE,
    detail: text(
      '在用的 provider 不用 OpenAI 的登录，这时 codex 不报 ChatGPT 的登录状态',
      'The active provider does not use the OpenAI login, so codex does not report it',
    ),
  }
  if (!home) return unknown
  let stored: unknown
  try {
    stored = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))
  } catch {
    return unknown
  }
  if (!isObject(stored)) return unknown
  if (isObject(stored.tokens)) {
    const said = claims(stored.tokens.id_token)
    const profile = isObject(said['https://api.openai.com/auth'])
      ? said['https://api.openai.com/auth']
      : {}
    const label = [said.email, profile.chatgpt_plan_type]
      .filter((part) => typeof part === 'string' && part)
      .join(' · ')
    return { signedIn: true, kind: 'oauth', label: label || null }
  }
  if (typeof stored.OPENAI_API_KEY === 'string' && stored.OPENAI_API_KEY)
    return { signedIn: true, kind: 'apiKey', label: null }
  return NONE
}

/** openai 现在的登录状态（account/read）。邮箱和套餐当 label */
export async function openaiAuth(ask: Ask, home: string | null): Promise<HarnessProviderAuthState> {
  const read = await ask('account/read', {}).catch(() => null)
  const account = isObject(read) && isObject(read.account) ? read.account : null
  if (!account) return isObject(read) && read.requiresOpenaiAuth === false ? storedAuth(home) : NONE
  if (account.type === 'chatgpt') {
    const label = [account.email, account.planType]
      .filter((part) => typeof part === 'string' && part && part !== 'unknown')
      .join(' · ')
    return { signedIn: true, kind: 'oauth', label: label || null }
  }
  if (account.type === 'apiKey') return { signedIn: true, kind: 'apiKey', label: null }
  return { signedIn: true, kind: 'oauth', label: String(account.type) }
}

/** openai 能用的登录方式，按管理员的 allowedLoginMethods（chatgpt、api）筛 */
function openaiMethods(snapshot: CodexSnapshot): HarnessAuthMethod[] {
  const allowed = snapshot.requirements?.allowedLoginMethods
  const permits = (kind: string) => !Array.isArray(allowed) || allowed.includes(kind)
  const methods: HarnessAuthMethod[] = []
  if (permits('chatgpt'))
    methods.push(
      {
        id: METHOD.chatgpt,
        kind: 'oauthBrowser',
        title: text('用 ChatGPT 登录', 'Sign in with ChatGPT'),
        description: text(
          '在浏览器里授权，授权完回调到设备上的 codex',
          'Authorize in the browser; it calls back to codex on the device',
        ),
      },
      {
        id: METHOD.deviceCode,
        kind: 'oauthDeviceCode',
        title: text('用设备码登录 ChatGPT', 'Sign in with a device code'),
        description: text('在任意一台设备的浏览器里输入码', 'Enter the code in any browser'),
      },
    )
  if (permits('api'))
    methods.push({
      id: METHOD.apiKey,
      kind: 'apiKey',
      title: text('用 OpenAI API key', 'Use an OpenAI API key'),
      description: text(
        'key 由 codex 存在它自己的凭据里',
        'codex stores the key with its own credentials',
      ),
      fields: [
        { id: 'apiKey', title: text('API key', 'API key'), secret: true, placeholder: 'sk-…' },
      ],
    })
  return methods
}

/** 自定义 provider 的凭据：环境变量在设备设置里填了算有 */
function customAuth(
  definition: Record<string, unknown>,
  envNames: string[],
  openai: HarnessProviderAuthState,
): HarnessProviderAuthState {
  if (definition.requires_openai_auth === true) return openai
  const name = typeof definition.env_key === 'string' ? definition.env_key : null
  if (name && envNames.includes(name)) return { signedIn: true, kind: 'env', label: name }
  if (!name) return { signedIn: true, kind: 'none', label: null }
  return {
    ...NONE,
    detail: text(`设备设置里还没有填 ${name}`, `${name} is not set in device settings`),
  }
}

function definitionOf(table: Record<string, unknown>): Record<string, HarnessSettingValue> {
  const definition: Record<string, HarnessSettingValue> = {}
  for (const spec of TEMPLATE_FIELDS) {
    const value = table[spec.key]
    if (value !== undefined && value !== null) definition[spec.key] = value as HarnessSettingValue
  }
  return definition
}

/** 当前在用的 provider（不写是 openai） */
export const activeProvider = (snapshot: CodexSnapshot): string =>
  typeof snapshot.config.model_provider === 'string' && snapshot.config.model_provider
    ? snapshot.config.model_provider
    : OPENAI

/** 生效配置里的自定义 provider（不在用户层的那些是别的层写的，改不了） */
export function customProviders(snapshot: CodexSnapshot): [string, Record<string, unknown>][] {
  const tables = isObject(snapshot.config.model_providers) ? snapshot.config.model_providers : {}
  return Object.entries(tables).filter(
    (entry): entry is [string, Record<string, unknown>] =>
      !RESERVED.has(entry[0]) && isObject(entry[1]),
  )
}

/** litch/harness/providers/read */
export async function readCodexProviders(
  ask: Ask,
  harness: string,
  envNames: string[],
  home: string | null,
): Promise<HarnessProvidersReadResponse> {
  const [snapshot, openai] = await Promise.all([readSnapshot(ask, harness), openaiAuth(ask, home)])
  const active = activeProvider(snapshot)
  const local = {
    signedIn: true,
    kind: 'none' as const,
    label: null,
    detail: text('本机的模型服务，不用登录', 'Local model server, no sign-in'),
  }
  const providers: HarnessProvider[] = [
    {
      id: OPENAI,
      title: text('OpenAI', 'OpenAI'),
      kind: 'builtin',
      auth: openai,
      methods: openaiMethods(snapshot),
      active: active === OPENAI,
      canLogout: openai.signedIn,
    },
    ...LOCAL.map(({ id, title }) => ({
      id,
      title: text(title, title),
      kind: 'builtin' as const,
      auth: local,
      methods: [],
      active: active === id,
      canLogout: false,
    })),
  ]
  for (const [id, table] of customProviders(snapshot)) {
    const envName = typeof table.env_key === 'string' && table.env_key ? table.env_key : null
    const name = typeof table.name === 'string' && table.name ? table.name : id
    providers.push({
      id,
      title: text(name, name),
      kind: 'custom',
      auth: customAuth(table, envNames, openai),
      methods: envName
        ? [
            {
              id: METHOD.env,
              kind: 'env',
              title: text('API key（环境变量）', 'API key (environment)'),
              description: null,
              envName,
              effect: 'harness',
            },
          ]
        : [],
      active: active === id,
      definition: definitionOf(table),
      templateId: TEMPLATE,
      // key 在设备设置里，登出就是把它从那里清掉，由客户端做
      canLogout: false,
    })
  }
  return { providers, switchable: true, templates: TEMPLATES, version: snapshot.version }
}

/** 键路径里的 provider 名 */
export const providerKey = (id: string): string => `model_providers.${segment(id)}`
