// harness 详情设置里 Claude Code 的账号与供应商：litch/harness/providers/*、auth/*。
// 账号一个（claude.ai 订阅或 Console，`claude auth login` 粘贴码登录，凭据由 CLI 自己存；另可存一个长期令牌）；
// 供应商多个（Anthropic API key、Anthropic 兼容网关），定义在适配器的 config.json，密钥在 provider-secrets.json。
// 不存在“当前在用的供应商”：会话按自己所选型号的供应商起 CLI（claude-provider.mts），所以 switchable 是 false。
// 用户自己在 settings.json、启动环境里配的凭据或网关列成只读的 native。Bedrock、Vertex、Foundry 这一版不做。
import type {
  HarnessAuthField,
  HarnessAuthStartResponse,
  HarnessAuthStep,
  HarnessProvider,
  HarnessProviderAuthState,
  HarnessProvidersReadResponse,
  HarnessProvidersWriteResponse,
  HarnessProviderTemplate,
  HarnessSettingSpec,
  HarnessText,
} from '../../protocol/src/harness-config.mjs'
import { HARNESS_CONFIG_NOTIFICATION } from '../../protocol/src/harness-config.mjs'
import {
  type ClaudeAuthStatus,
  ClaudeLoginAttempt,
  claudeAuthLogout,
  claudeAuthStatus,
  type LoginMode,
  type LoginOutcome,
} from './claude-auth.mjs'
import {
  ACCOUNT_PROVIDER,
  NATIVE_PROVIDER,
  nativeOverrides,
  PROVIDER_ID_PATTERN,
  type ProviderConfig,
  type ProviderDefinition,
  type ProviderModel,
  providerConfigVersion,
  providerLaunch,
  readProviderConfig,
  readProviderSecrets,
  secretLabel,
  writeProviderConfig,
  writeProviderSecret,
} from './claude-provider.mjs'
import { CLAUDE_HARNESS_ID, HarnessConfigError, text } from './harness-config-common.mjs'

export interface ProvidersHost {
  /** 只发给握手时声明了 harnessConfig 的连接 */
  broadcast(method: string, params: unknown): void
  /** 供应商的定义或密钥变了：适配器重算模型目录 */
  providersChanged?(): void
}

const API_KEY_TEMPLATE = 'anthropicApiKey'
const GATEWAY_TEMPLATE = 'anthropicGateway'

const CODE_FIELD: HarnessAuthField = {
  id: 'code',
  title: text('授权码', 'Authorization code'),
  secret: true,
  placeholder: 'xxxx#yyyy',
}

const API_KEY_FIELD: HarnessAuthField = {
  id: 'apiKey',
  title: text('密钥', 'Key'),
  secret: true,
}

const TOKEN_FIELD: HarnessAuthField = {
  id: 'token',
  title: text('长期令牌', 'Long-lived token'),
  secret: true,
  placeholder: 'sk-ant-oat01-…',
}

// 远程 Mac 上经 SSH 起的进程，登录钥匙串可能锁着，CLI 存不进凭据（风险，没在真机上验过）
const KEYCHAIN_HINT = text(
  '如果设备是经 SSH 连的 Mac，登录钥匙串可能锁着、凭据存不进去：先在那台 Mac 上解锁钥匙串（security unlock-keychain），或者在任何一台登录过的电脑上运行 claude setup-token，把生成的令牌填到“长期令牌”。',
  'If the device is a Mac reached over SSH, its login keychain may be locked and the credentials cannot be saved: unlock it there (security unlock-keychain), or run claude setup-token on any signed-in computer and paste the token into "Long-lived token".',
)

function joinText(...parts: Array<HarnessText | null>): HarnessText {
  const present = parts.filter((part): part is HarnessText => part !== null)
  return {
    'zh-CN': present.map((part) => part['zh-CN']).join('\n'),
    en: present.map((part) => part.en).join('\n'),
  }
}

function accountAuth(status: ClaudeAuthStatus): HarnessProviderAuthState {
  if (!status.loggedIn) return { signedIn: false, kind: 'none', label: null }
  const who = (...parts: Array<string | null>) => parts.filter(Boolean).join(' · ') || null
  switch (status.authMethod) {
    case 'claude.ai':
      return { signedIn: true, kind: 'oauth', label: who(status.email, status.subscriptionType) }
    case 'oauth_token':
      return { signedIn: true, kind: 'env', label: 'CLAUDE_CODE_OAUTH_TOKEN' }
    case 'api_key':
      // Console 登录：CLI 替账号建了一把 key，自己存着
      return status.apiKeySource === '/login managed key'
        ? { signedIn: true, kind: 'oauth', label: who(status.email, status.orgName) ?? 'Console' }
        : { signedIn: true, kind: 'apiKey', label: status.apiKeySource }
    case 'api_key_helper':
      return { signedIn: true, kind: 'apiKey', label: 'apiKeyHelper' }
    default:
      return { signedIn: true, kind: 'env', label: status.authMethod }
  }
}

const field = (
  key: string,
  type: HarnessSettingSpec['type'],
  title: HarnessText,
  extra: Partial<HarnessSettingSpec> = {},
): HarnessSettingSpec => ({
  key,
  group: 'provider',
  type,
  title,
  description: null,
  default: null,
  effect: 'newSession',
  ...extra,
})

const TITLE_FIELD = field('title', 'string', text('名字', 'Name'), {
  description: text(
    '模型选单里显示成“[名字] 模型”。',
    'Shown as "[Name] model" in the model menu.',
  ),
})
const KEY_SPEC = field('apiKey', 'secret', text('密钥', 'Key'))

function apiKeyTemplate(): HarnessProviderTemplate {
  return {
    id: API_KEY_TEMPLATE,
    title: text('Anthropic API key', 'Anthropic API key'),
    description: text(
      'Console 里建的 key，经 x-api-key 发给 Anthropic。可以加几个（比如不同组织的 key）。',
      'A Console API key, sent as x-api-key. Add several for different organizations.',
    ),
    fields: [
      TITLE_FIELD,
      KEY_SPEC,
      field('baseUrl', 'string', text('地址', 'Base URL'), {
        description: text('不填用官方地址。', 'Leave empty for the official endpoint.'),
        placeholder: 'https://api.anthropic.com',
      }),
    ],
  }
}

function gatewayTemplate(): HarnessProviderTemplate {
  return {
    id: GATEWAY_TEMPLATE,
    title: text('Anthropic 兼容网关', 'Anthropic-compatible gateway'),
    description: text(
      '自己的网关、代理，或提供 Anthropic 接口的第三方模型服务。',
      'Your own gateway or proxy, or a third-party service with an Anthropic-compatible API.',
    ),
    fields: [
      TITLE_FIELD,
      field('baseUrl', 'string', text('地址', 'Base URL'), {
        clearable: false,
        placeholder: 'https://gateway.example.com',
      }),
      KEY_SPEC,
      field('authHeader', 'enum', text('密钥放在哪', 'Key header'), {
        default: 'bearer',
        options: [
          { value: 'bearer', title: text('Authorization: Bearer', 'Authorization: Bearer') },
          { value: 'apiKey', title: text('x-api-key', 'x-api-key') },
        ],
      }),
      field('models', 'stringList', text('型号', 'Models'), {
        description: text(
          '每行一个型号 ID，要显示别的名字写成“ID = 名字”。可以从网关拉取。',
          'One model ID per line; write "ID = Name" for a display name. Can be fetched from the gateway.',
        ),
      }),
      field('smallModel', 'string', text('小模型', 'Small model'), {
        description: text(
          'Claude Code 起标题、haiku 档等内部请求用的型号。不填用会话所选的型号。',
          'Used for titles and other internal haiku-tier requests. Defaults to the session model.',
        ),
      }),
      field('headers', 'text', text('额外请求头', 'Extra headers'), {
        description: text('每行一个“名字: 值”。', 'One "Name: Value" per line.'),
      }),
    ],
    discoverModels: 'models',
  }
}

function modelLines(models: ProviderModel[]): string[] {
  return models.map((model) => (model.title ? `${model.id} = ${model.title}` : model.id))
}

function parseModelLines(value: unknown): ProviderModel[] {
  const lines = Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : []
  const seen = new Set<string>()
  const models: ProviderModel[] = []
  for (const line of lines) {
    if (typeof line !== 'string') continue
    const at = line.indexOf('=')
    const id = (at < 0 ? line : line.slice(0, at)).trim()
    const title = at < 0 ? '' : line.slice(at + 1).trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    models.push({ id, title: title || null })
  }
  return models
}

function hostOf(baseUrl: string | null): string | null {
  if (!baseUrl) return null
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

interface Attempt {
  login: ClaudeLoginAttempt
  /** 结局对应的一步：continue 的应答和 auth/updated 通知共用，只查一次登录状态 */
  final: Promise<HarnessAuthStep> | null
}

export interface DiscoveredModels {
  models: ProviderModel[]
}

export class ClaudeProviders {
  private readonly host: ProvidersHost
  private readonly attempts = new Map<string, Attempt>()

  constructor(host: ProvidersHost) {
    this.host = host
  }

  // 按账号算的环境：查状态、登录、登出都用它。auth 子命令不收 --settings，用户 settings.json 里另配的
  // 凭据会让它报的不是账号（读的时候另加提示）
  private accountEnv(): NodeJS.ProcessEnv {
    return providerLaunch(ACCOUNT_PROVIDER, null).env
  }

  private async accountState(): Promise<HarnessProviderAuthState> {
    try {
      return accountAuth(await claudeAuthStatus(this.accountEnv()))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        signedIn: false,
        kind: 'none',
        label: null,
        detail: text(`读不到登录状态：${message}`, `Cannot read the sign-in status: ${message}`),
      }
    }
  }

  async read(): Promise<HarnessProvidersReadResponse> {
    const config = readProviderConfig()
    const secrets = readProviderSecrets()
    const account = await this.accountState()
    const token = secrets[ACCOUNT_PROVIDER]
    if (!account.signedIn && token)
      Object.assign(account, { signedIn: true, kind: 'apiKey', label: secretLabel(token) })
    const overrides = nativeOverrides()
    const providers: HarnessProvider[] = [
      {
        id: ACCOUNT_PROVIDER,
        title: text('Anthropic 账号', 'Anthropic account'),
        kind: 'builtin',
        auth: account,
        methods: [
          {
            id: 'claudeai',
            kind: 'oauthPaste',
            title: text('Claude 订阅（claude.ai）', 'Claude subscription (claude.ai)'),
            description: text(
              'Pro、Max、Team、Enterprise 账号。',
              'Pro, Max, Team or Enterprise plans.',
            ),
          },
          {
            id: 'console',
            kind: 'oauthPaste',
            title: text('Anthropic Console', 'Anthropic Console'),
            description: text('按 API 用量计费。', 'Billed by API usage.'),
          },
          {
            id: 'oauthToken',
            kind: 'apiKey',
            fields: [TOKEN_FIELD],
            title: text('长期令牌', 'Long-lived token'),
            description: text(
              '在任何一台登录过的电脑上运行 claude setup-token，把输出的令牌填在这里。设备上存不了凭据（远程 Mac 的钥匙串锁着）时用它。',
              'Run claude setup-token on any signed-in computer and paste the token here. Use it when the device cannot store credentials (e.g. a locked keychain on a remote Mac).',
            ),
          },
        ],
        active: false,
        canLogout: account.signedIn && (account.kind === 'oauth' || Boolean(token)),
      },
      ...(overrides.length > 0
        ? [
            {
              id: NATIVE_PROVIDER,
              title: text('Claude Code 自己的配置', 'Claude Code configuration'),
              kind: 'builtin' as const,
              auth: {
                signedIn: true,
                kind: 'env' as const,
                label: overrides.join(', '),
                detail: text(
                  '启动环境或 settings.json 里另配了凭据或模型服务。选这个供应商的型号时原样照它走；在这里改不了。',
                  'Credentials or a model service are configured in the environment or settings.json. Models from this provider use it as is; it cannot be edited here.',
                ),
              },
              methods: [],
              active: false,
              canLogout: false,
            },
          ]
        : []),
      ...Object.entries(config.providers).map(([id, provider]) =>
        this.customProvider(id, provider, secrets[id] ?? null),
      ),
    ]
    return {
      providers,
      switchable: false,
      templates: [apiKeyTemplate(), gatewayTemplate()],
      version: providerConfigVersion(config, secrets),
    }
  }

  private customProvider(
    id: string,
    provider: ProviderDefinition,
    secret: string | null,
  ): HarnessProvider {
    const host = hostOf(provider.baseUrl)
    return {
      id,
      title: text(provider.title ?? id, provider.title ?? id),
      kind: 'custom',
      auth: secret
        ? {
            signedIn: true,
            kind: 'apiKey',
            label: [secretLabel(secret), host].filter(Boolean).join(' · '),
          }
        : { signedIn: false, kind: 'none', label: host },
      methods: [
        {
          id: 'apiKey',
          kind: 'apiKey',
          fields: [API_KEY_FIELD],
          title: text('密钥', 'Key'),
          description: null,
        },
      ],
      active: false,
      definition: {
        ...(provider.title ? { title: provider.title } : {}),
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
        apiKey: { set: secret !== null },
        ...(provider.kind === 'gateway'
          ? {
              authHeader: provider.authHeader,
              models: modelLines(provider.models),
              ...(provider.smallModel ? { smallModel: provider.smallModel } : {}),
              ...(provider.headers ? { headers: provider.headers } : {}),
            }
          : {}),
      },
      templateId: provider.kind === 'gateway' ? GATEWAY_TEMPLATE : API_KEY_TEMPLATE,
      canLogout: secret !== null,
    }
  }

  private checkVersion(expected: unknown): void {
    if (typeof expected !== 'string')
      throw new HarnessConfigError(
        'invalidValue',
        text('缺少 expectedVersion', 'expectedVersion is required'),
      )
    if (expected !== providerConfigVersion())
      throw new HarnessConfigError(
        'versionConflict',
        text('供应商配置已经变了，请重新读取', 'Providers changed; reload them'),
      )
  }

  private changed(): HarnessProvidersWriteResponse {
    this.host.providersChanged?.()
    this.host.broadcast(HARNESS_CONFIG_NOTIFICATION.changed, {
      harness: CLAUDE_HARNESS_ID,
      part: 'providers',
    })
    return { version: providerConfigVersion(), restartRequired: false }
  }

  private custom(id: unknown, config: ProviderConfig): ProviderDefinition {
    if (id === ACCOUNT_PROVIDER || id === NATIVE_PROVIDER)
      throw new HarnessConfigError(
        'readOnly',
        text('内置的供应商不能改', 'Built-in providers cannot be edited'),
        'providerId',
      )
    if (typeof id !== 'string' || !Object.hasOwn(config.providers, id))
      throw new HarnessConfigError(
        'notFound',
        text(`没有供应商 ${String(id)}`, `No provider ${String(id)}`),
        'providerId',
      )
    return config.providers[id] as ProviderDefinition
  }

  upsert(params: Record<string, unknown>): HarnessProvidersWriteResponse {
    this.checkVersion(params.expectedVersion)
    const config = readProviderConfig()
    const id = params.providerId
    if (id === ACCOUNT_PROVIDER || id === NATIVE_PROVIDER)
      throw new HarnessConfigError(
        'readOnly',
        text('内置的供应商不能改', 'Built-in providers cannot be edited'),
        'providerId',
      )
    if (typeof id !== 'string' || !PROVIDER_ID_PATTERN.test(id))
      throw new HarnessConfigError(
        'invalidValue',
        text(
          'providerId 只能用字母、数字和 - _，最长 32 个字',
          'providerId may only contain letters, digits, - and _ (up to 32)',
        ),
        'providerId',
      )
    const kind =
      params.templateId === GATEWAY_TEMPLATE
        ? 'gateway'
        : params.templateId === API_KEY_TEMPLATE
          ? 'apiKey'
          : null
    if (kind === null)
      throw new HarnessConfigError(
        'notFound',
        text('没有这个模板', 'Unknown template'),
        'templateId',
      )
    const existing = config.providers[id]
    if (existing && existing.kind !== kind)
      throw new HarnessConfigError(
        'invalidValue',
        text(
          '不能改供应商的类型，删掉重加',
          'The provider type cannot change; remove and add it again',
        ),
        'templateId',
      )
    // 改已有的：没给的项照旧（详情设置的表单只送改过的那几栏）
    const given = (params.definition ?? {}) as Record<string, unknown>
    const definition: Record<string, unknown> = {
      ...(existing
        ? {
            title: existing.title,
            baseUrl: existing.baseUrl,
            authHeader: existing.authHeader,
            models: modelLines(existing.models),
            smallModel: existing.smallModel,
            headers: existing.headers,
          }
        : {}),
      ...given,
    }
    const baseUrl = typeof definition.baseUrl === 'string' ? definition.baseUrl.trim() : ''
    if (baseUrl || kind === 'gateway') {
      let url: URL | null = null
      try {
        url = new URL(baseUrl)
      } catch {}
      if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:'))
        throw new HarnessConfigError(
          'invalidValue',
          text('地址要是 http 或 https 地址', 'Base URL must be an http(s) URL'),
          'baseUrl',
        )
    }
    if (
      definition.authHeader != null &&
      definition.authHeader !== 'bearer' &&
      definition.authHeader !== 'apiKey'
    )
      throw new HarnessConfigError(
        'invalidValue',
        text('密钥位置只能是 bearer 或 apiKey', 'authHeader must be bearer or apiKey'),
        'authHeader',
      )
    const string = (value: unknown) =>
      typeof value === 'string' && value.trim() ? value.trim() : null
    config.providers[id] = {
      kind,
      title: string(definition.title),
      baseUrl: baseUrl || null,
      authHeader: kind === 'gateway' && definition.authHeader !== 'apiKey' ? 'bearer' : 'apiKey',
      models: kind === 'gateway' ? parseModelLines(definition.models) : [],
      smallModel: kind === 'gateway' ? string(definition.smallModel) : null,
      headers: kind === 'gateway' ? string(definition.headers) : null,
    }
    writeProviderConfig(config)
    // 密钥：给了字串就换（空串是清掉）；不给、或原样交回读到的 {set} 不动
    if (typeof definition.apiKey === 'string')
      writeProviderSecret(id, definition.apiKey.trim() || null)
    return this.changed()
  }

  remove(params: Record<string, unknown>): HarnessProvidersWriteResponse {
    if (params.expectedVersion != null) this.checkVersion(params.expectedVersion)
    const config = readProviderConfig()
    const id = params.providerId as string
    this.custom(id, config)
    delete config.providers[id]
    // 上一次选的正是它的型号：新会话回到账号（不悄悄换到别家）
    if (config.last?.startsWith(`${id}/`)) config.last = null
    writeProviderConfig(config)
    writeProviderSecret(id, null)
    return this.changed()
  }

  activate(_params: Record<string, unknown>): HarnessProvidersWriteResponse {
    throw new HarnessConfigError(
      'invalidValue',
      text(
        'Claude Code 没有“当前供应商”：每个会话按所选型号的供应商来',
        'Claude Code has no active provider: each session uses the provider of its model',
      ),
      'providerId',
    )
  }

  /** 网关的 GET /v1/models：列出它有的型号给用户勾，不写任何东西 */
  async discoverModels(params: Record<string, unknown>): Promise<DiscoveredModels> {
    const config = readProviderConfig()
    const provider = this.custom(params.providerId, config)
    if (provider.kind !== 'gateway' || !provider.baseUrl)
      throw new HarnessConfigError(
        'invalidValue',
        text('只有网关能拉取型号', 'Only gateways can list models'),
        'providerId',
      )
    const secret = readProviderSecrets()[params.providerId as string]
    if (!secret)
      throw new HarnessConfigError(
        'invalidValue',
        text('先填密钥', 'Set the key first'),
        'providerId',
      )
    const url = `${provider.baseUrl.replace(/\/+$/, '')}/v1/models?limit=1000`
    const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' }
    if (provider.authHeader === 'bearer') headers.authorization = `Bearer ${secret}`
    else headers['x-api-key'] = secret
    let response: Response
    try {
      response = await fetch(url, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new HarnessConfigError(
        'invalidValue',
        text(`连不上网关：${message}`, `Cannot reach the gateway: ${message}`),
      )
    }
    if (!response.ok)
      throw new HarnessConfigError(
        'invalidValue',
        text(`网关回了 ${response.status}`, `The gateway answered ${response.status}`),
      )
    const body = (await response.json().catch(() => null)) as { data?: unknown } | null
    const models = parseModelLines(
      (Array.isArray(body?.data) ? body.data : []).flatMap((entry: unknown) => {
        const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
        if (typeof record.id !== 'string') return []
        const title = typeof record.display_name === 'string' ? record.display_name.trim() : ''
        return [title && title !== record.id ? `${record.id} = ${title}` : record.id]
      }),
    )
    return { models }
  }

  // ---------- 登录 ----------

  async authStart(params: Record<string, unknown>): Promise<HarnessAuthStartResponse> {
    const providerId = params.providerId
    const methodId = params.methodId
    const inputs = (params.inputs ?? {}) as Record<string, unknown>
    // 填密钥（长期令牌、供应商的 key）：当场写进密钥文件，不经 CLI
    if (
      (providerId === ACCOUNT_PROVIDER && methodId === 'oauthToken') ||
      (providerId !== ACCOUNT_PROVIDER && methodId === 'apiKey')
    ) {
      if (providerId !== ACCOUNT_PROVIDER) this.custom(providerId, readProviderConfig())
      const fieldId = providerId === ACCOUNT_PROVIDER ? 'token' : 'apiKey'
      const value = typeof inputs[fieldId] === 'string' ? (inputs[fieldId] as string).trim() : ''
      if (!value)
        return {
          attemptId: `${String(providerId)}-${String(methodId)}`,
          step: {
            kind: 'prompt',
            fields: [providerId === ACCOUNT_PROVIDER ? TOKEN_FIELD : API_KEY_FIELD],
            message: null,
          },
        }
      writeProviderSecret(providerId as string, value)
      this.changed()
      return {
        attemptId: `${String(providerId)}-${String(methodId)}`,
        step: {
          kind: 'done',
          auth:
            providerId === ACCOUNT_PROVIDER
              ? await this.accountState()
              : { signedIn: true, kind: 'apiKey', label: secretLabel(value) },
        },
      }
    }
    if (providerId !== ACCOUNT_PROVIDER || (methodId !== 'claudeai' && methodId !== 'console'))
      throw new HarnessConfigError(
        'invalidValue',
        text('没有这种登录方式', 'Unknown sign-in method'),
        'methodId',
      )
    // 同一时间只留一次登录：CLI 每次都起一个新的授权流程，旧的码交不上了
    for (const attempt of this.attempts.values()) attempt.login.cancel()
    const login = new ClaudeLoginAttempt(methodId as LoginMode)
    const attempt: Attempt = { login, final: null }
    this.attempts.set(login.id, attempt)
    login.onSettled = (outcome) => {
      this.attempts.delete(login.id)
      void this.finalStep(attempt, outcome).then((step) => {
        this.host.broadcast(HARNESS_CONFIG_NOTIFICATION.authUpdated, {
          harness: CLAUDE_HARNESS_ID,
          attemptId: login.id,
          providerId: ACCOUNT_PROVIDER,
          step,
        })
        if (step.kind === 'done') this.changed()
      })
    }
    let url: string
    try {
      url = await login.start(this.accountEnv())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new HarnessConfigError(
        'authFailed',
        text(`登录没能开始：${message}`, `Sign-in could not start: ${message}`),
      )
    }
    return {
      attemptId: login.id,
      step: {
        kind: 'openUrl',
        url,
        callbackPort: null,
        message: joinText(
          text(
            '在浏览器里打开链接、授权，把页面上显示的授权码整段复制回来。',
            'Open the link, authorize, then paste the whole code shown on the page.',
          ),
          process.platform === 'darwin' ? KEYCHAIN_HINT : null,
        ),
        prompt: [CODE_FIELD],
      },
    }
  }

  private finalStep(attempt: Attempt, outcome: LoginOutcome): Promise<HarnessAuthStep> {
    attempt.final ??= (async (): Promise<HarnessAuthStep> => {
      if (outcome.kind === 'cancelled')
        return { kind: 'failed', message: text('登录已取消', 'Sign-in cancelled') }
      if (outcome.kind === 'failed') {
        const keychain = /keychain|security/i.test(outcome.message)
        return {
          kind: 'failed',
          message: joinText(
            text(`登录失败：${outcome.message}`, `Sign-in failed: ${outcome.message}`),
            keychain ? KEYCHAIN_HINT : null,
          ),
        }
      }
      return { kind: 'done', auth: await this.accountState() }
    })()
    return attempt.final
  }

  async authContinue(params: Record<string, unknown>): Promise<HarnessAuthStep> {
    const attempt = this.attempts.get(String(params.attemptId))
    if (!attempt)
      throw new HarnessConfigError(
        'notFound',
        text('没有这次登录（已经结束或被取消）', 'No such sign-in (finished or cancelled)'),
        'attemptId',
      )
    const inputs = (params.inputs ?? {}) as Record<string, unknown>
    const code = typeof inputs.code === 'string' ? inputs.code : ''
    const outcome = await attempt.login.submit(code)
    if (outcome === null)
      return {
        kind: 'prompt',
        fields: [CODE_FIELD],
        message: text(
          '授权码不完整：要把页面上的码整段复制过来（中间有一个 #）。',
          'Incomplete code: copy the whole code from the page (it contains a #).',
        ),
      }
    return this.finalStep(attempt, outcome)
  }

  authCancel(params: Record<string, unknown>): Record<string, never> {
    const attempt = this.attempts.get(String(params.attemptId))
    if (!attempt)
      throw new HarnessConfigError('notFound', text('没有这次登录', 'No such sign-in'), 'attemptId')
    attempt.login.cancel()
    return {}
  }

  async authLogout(params: Record<string, unknown>): Promise<Record<string, never>> {
    const providerId = params.providerId
    if (providerId === NATIVE_PROVIDER)
      throw new HarnessConfigError(
        'readOnly',
        text(
          '这些凭据在启动环境或 settings.json 里，到那里去改',
          'These credentials live in the environment or settings.json; change them there',
        ),
        'providerId',
      )
    if (providerId === ACCOUNT_PROVIDER) {
      // 登出连同存的长期令牌一起清掉；供应商和它们的密钥不动
      writeProviderSecret(ACCOUNT_PROVIDER, null)
      try {
        await claudeAuthLogout(this.accountEnv())
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new HarnessConfigError(
          'authFailed',
          text(`登出失败：${message}`, `Sign-out failed: ${message}`),
        )
      }
      this.changed()
      return {}
    }
    this.custom(providerId, readProviderConfig())
    writeProviderSecret(providerId as string, null)
    this.changed()
    return {}
  }

  close(): void {
    for (const attempt of this.attempts.values()) attempt.login.cancel()
  }
}
