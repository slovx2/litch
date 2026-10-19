// harness 详情设置里 Claude Code 的账号与 provider：litch/harness/providers/*、auth/*。
// 三种互斥（switchable）：Anthropic 账号（claude.ai 订阅或 Console，`claude auth login` 粘贴码登录，
// 凭据由 CLI 自己存）、API key、自定义网关（可以有几个，地址记在适配器的 config.json）。
// 后两种的密钥和账号的长期令牌是 env 方式：客户端写进设备设置的 harness.claude-code.env，适配器重启后读到，
// 起 CLI 时按选择换成 ANTHROPIC_*（claude-provider.mts）。Bedrock、Vertex、Foundry 这一版不做。
import type {
  HarnessAuthField,
  HarnessAuthStartResponse,
  HarnessAuthStep,
  HarnessProvider,
  HarnessProviderAuthState,
  HarnessProvidersReadResponse,
  HarnessProvidersWriteResponse,
  HarnessProviderTemplate,
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
import { contentHash } from './claude-native-files.mjs'
import {
  ACCOUNT_PROVIDER,
  API_KEY_PROVIDER,
  applyProviderEnv,
  ENV_API_KEY,
  ENV_OAUTH_TOKEN,
  GATEWAY_ID_PATTERN,
  type GatewayDefinition,
  gatewayTokenEnv,
  type ProviderSelection,
  readProviderSelection,
  writeProviderSelection,
} from './claude-provider.mjs'
import { CLAUDE_HARNESS_ID, HarnessConfigError, text } from './harness-config-common.mjs'

export interface ProvidersHost {
  /** 只发给握手时声明了 harnessConfig 的连接 */
  broadcast(method: string, params: unknown): void
}

const GATEWAY_TEMPLATE = 'anthropicGateway'

const CODE_FIELD: HarnessAuthField = {
  id: 'code',
  title: text('授权码', 'Authorization code'),
  secret: true,
  placeholder: 'xxxx#yyyy',
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

function tail(value: string): string {
  return value.length > 8 ? `…${value.slice(-4)}` : '已设置'
}

function envAuth(name: string, label: (value: string) => string): HarnessProviderAuthState {
  const value = process.env[name]
  return value
    ? { signedIn: true, kind: 'env', label: label(value) }
    : { signedIn: false, kind: 'none', label: null }
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

function gatewayTemplate(): HarnessProviderTemplate {
  return {
    id: GATEWAY_TEMPLATE,
    title: text('Anthropic 兼容网关', 'Anthropic-compatible gateway'),
    description: text(
      '经 ANTHROPIC_BASE_URL 走自己的网关或代理。令牌另外在“网关令牌”里填。',
      'Route through your own gateway via ANTHROPIC_BASE_URL. Set the token under "Gateway token".',
    ),
    fields: [
      {
        key: 'title',
        group: 'provider',
        type: 'string',
        title: text('名字', 'Name'),
        description: null,
        default: null,
        effect: 'newSession',
      },
      {
        key: 'baseUrl',
        group: 'provider',
        type: 'string',
        title: text('网关地址', 'Base URL'),
        description: text('写进 ANTHROPIC_BASE_URL。', 'Becomes ANTHROPIC_BASE_URL.'),
        default: null,
        effect: 'newSession',
        clearable: false,
        placeholder: 'https://gateway.example.com',
      },
      {
        key: 'authHeader',
        group: 'provider',
        type: 'enum',
        title: text('令牌放在哪', 'Token header'),
        description: null,
        default: 'bearer',
        effect: 'newSession',
        options: [
          {
            value: 'bearer',
            title: text(
              'Authorization: Bearer（ANTHROPIC_AUTH_TOKEN）',
              'Authorization: Bearer (ANTHROPIC_AUTH_TOKEN)',
            ),
          },
          {
            value: 'apiKey',
            title: text('x-api-key（ANTHROPIC_API_KEY）', 'x-api-key (ANTHROPIC_API_KEY)'),
          },
        ],
      },
    ],
  }
}

function selectionVersion(selection: ProviderSelection): string {
  return contentHash(JSON.stringify(selection))
}

interface Attempt {
  login: ClaudeLoginAttempt
  /** 结局对应的一步：continue 的应答和 auth/updated 通知共用，只查一次登录状态 */
  final: Promise<HarnessAuthStep> | null
}

export class ClaudeProviders {
  private readonly host: ProvidersHost
  private readonly attempts = new Map<string, Attempt>()

  constructor(host: ProvidersHost) {
    this.host = host
  }

  // 按账号算的环境：查状态、登录、登出都用它，不受当前选的是 API key 还是网关影响
  private accountEnv(selection = readProviderSelection()): NodeJS.ProcessEnv {
    return applyProviderEnv(process.env, selection, ACCOUNT_PROVIDER)
  }

  private async accountState(selection: ProviderSelection): Promise<HarnessProviderAuthState> {
    try {
      return accountAuth(await claudeAuthStatus(this.accountEnv(selection)))
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
    const selection = readProviderSelection()
    const active = selection.active ?? ACCOUNT_PROVIDER
    const account = await this.accountState(selection)
    // 没选过时环境原样交给 CLI：设备环境里有 ANTHROPIC_* 的话实际用的是它
    if (
      selection.active === null &&
      ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'].some(
        (name) => process.env[name],
      )
    )
      account.detail = text(
        '还没选过用哪种：设备环境里的 ANTHROPIC_* 变量原样生效，可能盖过这个账号。选一次之后按选的来。',
        'No provider chosen yet: ANTHROPIC_* variables from the device environment are passed through and may take precedence. Choose one to override.',
      )
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
            kind: 'env',
            envName: ENV_OAUTH_TOKEN,
            effect: 'harness',
            title: text('长期令牌', 'Long-lived token'),
            description: text(
              '在任何一台登录过的电脑上运行 claude setup-token，把输出的令牌填在这里。设备上存不了凭据（远程 Mac 的钥匙串锁着）时用它。',
              'Run claude setup-token on any signed-in computer and paste the token here. Use it when the device cannot store credentials (e.g. a locked keychain on a remote Mac).',
            ),
          },
        ],
        active: active === ACCOUNT_PROVIDER,
        canLogout: account.signedIn && account.kind === 'oauth',
      },
      {
        id: API_KEY_PROVIDER,
        title: text('API key', 'API key'),
        kind: 'builtin',
        auth: envAuth(ENV_API_KEY, tail),
        methods: [
          {
            id: 'apiKey',
            kind: 'env',
            envName: ENV_API_KEY,
            effect: 'harness',
            title: text('API key', 'API key'),
            description: text(
              'Console 里建的 key，作为 ANTHROPIC_API_KEY 交给 Claude Code。',
              'A Console API key, passed as ANTHROPIC_API_KEY.',
            ),
          },
        ],
        active: active === API_KEY_PROVIDER,
        canLogout: false,
      },
      ...Object.entries(selection.gateways).map(([id, gateway]) =>
        this.gatewayProvider(id, gateway, active),
      ),
    ]
    return {
      providers,
      switchable: true,
      templates: [gatewayTemplate()],
      version: selectionVersion(selection),
    }
  }

  private gatewayProvider(id: string, gateway: GatewayDefinition, active: string): HarnessProvider {
    let host = gateway.baseUrl
    try {
      host = new URL(gateway.baseUrl).host
    } catch {}
    return {
      id,
      title: text(gateway.title ?? id, gateway.title ?? id),
      kind: 'custom',
      auth: envAuth(gatewayTokenEnv(id), () => host),
      methods: [
        {
          id: 'token',
          kind: 'env',
          envName: gatewayTokenEnv(id),
          effect: 'harness',
          title: text('网关令牌', 'Gateway token'),
          description: null,
        },
      ],
      active: active === id,
      definition: {
        ...(gateway.title ? { title: gateway.title } : {}),
        baseUrl: gateway.baseUrl,
        authHeader: gateway.authHeader,
      },
      templateId: GATEWAY_TEMPLATE,
      canLogout: false,
    }
  }

  private checkVersion(selection: ProviderSelection, expected: unknown): void {
    if (typeof expected !== 'string')
      throw new HarnessConfigError(
        'invalidValue',
        text('缺少 expectedVersion', 'expectedVersion is required'),
      )
    if (expected !== selectionVersion(selection))
      throw new HarnessConfigError(
        'versionConflict',
        text('provider 配置已经变了，请重新读取', 'Providers changed; reload them'),
      )
  }

  private save(selection: ProviderSelection): HarnessProvidersWriteResponse {
    writeProviderSelection(selection)
    this.changed()
    return { version: selectionVersion(readProviderSelection()), restartRequired: false }
  }

  private changed(): void {
    this.host.broadcast(HARNESS_CONFIG_NOTIFICATION.changed, {
      harness: CLAUDE_HARNESS_ID,
      part: 'providers',
    })
  }

  upsert(params: Record<string, unknown>): HarnessProvidersWriteResponse {
    const selection = readProviderSelection()
    this.checkVersion(selection, params.expectedVersion)
    const id = params.providerId
    if (typeof id !== 'string' || !GATEWAY_ID_PATTERN.test(id))
      throw new HarnessConfigError(
        'invalidValue',
        text(
          'providerId 只能用字母、数字和 - _',
          'providerId may only contain letters, digits, - and _',
        ),
        'providerId',
      )
    if (id === ACCOUNT_PROVIDER || id === API_KEY_PROVIDER)
      throw new HarnessConfigError(
        'readOnly',
        text('内置的 provider 不能改', 'Built-in providers cannot be edited'),
        'providerId',
      )
    if (params.templateId !== GATEWAY_TEMPLATE)
      throw new HarnessConfigError(
        'notFound',
        text('没有这个模板', 'Unknown template'),
        'templateId',
      )
    const clash = Object.keys(selection.gateways).find(
      (other) => other !== id && gatewayTokenEnv(other) === gatewayTokenEnv(id),
    )
    if (clash)
      throw new HarnessConfigError(
        'invalidValue',
        text(
          `和 ${clash} 的令牌变量名重了，换个 id`,
          `Its token variable clashes with ${clash}; pick another id`,
        ),
        'providerId',
      )
    const definition = (params.definition ?? {}) as Record<string, unknown>
    const baseUrl = typeof definition.baseUrl === 'string' ? definition.baseUrl.trim() : ''
    let url: URL | null = null
    try {
      url = new URL(baseUrl)
    } catch {}
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:'))
      throw new HarnessConfigError(
        'invalidValue',
        text('网关地址要是 http 或 https 地址', 'Base URL must be an http(s) URL'),
        'baseUrl',
      )
    if (
      definition.authHeader != null &&
      definition.authHeader !== 'bearer' &&
      definition.authHeader !== 'apiKey'
    )
      throw new HarnessConfigError(
        'invalidValue',
        text('令牌位置只能是 bearer 或 apiKey', 'authHeader must be bearer or apiKey'),
        'authHeader',
      )
    const title = typeof definition.title === 'string' ? definition.title.trim() : ''
    selection.gateways[id] = {
      title: title || null,
      baseUrl,
      authHeader: definition.authHeader === 'apiKey' ? 'apiKey' : 'bearer',
    }
    return this.save(selection)
  }

  remove(params: Record<string, unknown>): HarnessProvidersWriteResponse {
    const selection = readProviderSelection()
    this.checkVersion(selection, params.expectedVersion)
    const id = params.providerId
    if (id === ACCOUNT_PROVIDER || id === API_KEY_PROVIDER)
      throw new HarnessConfigError(
        'readOnly',
        text('内置的 provider 不能删', 'Built-in providers cannot be removed'),
        'providerId',
      )
    if (typeof id !== 'string' || !Object.hasOwn(selection.gateways, id))
      throw new HarnessConfigError(
        'notFound',
        text(`没有 provider ${String(id)}`, `No provider ${String(id)}`),
        'providerId',
      )
    delete selection.gateways[id]
    // 删的是正在用的：退回账号（不回到“没选过”，免得悄悄用上环境里别的凭据）
    if (selection.active === id) selection.active = ACCOUNT_PROVIDER
    return this.save(selection)
  }

  activate(params: Record<string, unknown>): HarnessProvidersWriteResponse {
    const selection = readProviderSelection()
    this.checkVersion(selection, params.expectedVersion)
    const id = params.providerId
    if (
      typeof id !== 'string' ||
      (id !== ACCOUNT_PROVIDER && id !== API_KEY_PROVIDER && !Object.hasOwn(selection.gateways, id))
    )
      throw new HarnessConfigError(
        'notFound',
        text(`没有 provider ${String(id)}`, `No provider ${String(id)}`),
        'providerId',
      )
    selection.active = id
    return this.save(selection)
  }

  // ---------- 登录 ----------

  async authStart(params: Record<string, unknown>): Promise<HarnessAuthStartResponse> {
    const providerId = params.providerId
    const methodId = params.methodId
    if (
      providerId !== ACCOUNT_PROVIDER &&
      providerId !== API_KEY_PROVIDER &&
      !Object.hasOwn(readProviderSelection().gateways, String(providerId))
    )
      throw new HarnessConfigError(
        'notFound',
        text(`没有 provider ${String(providerId)}`, `No provider ${String(providerId)}`),
        'providerId',
      )
    if (providerId !== ACCOUNT_PROVIDER || (methodId !== 'claudeai' && methodId !== 'console'))
      throw new HarnessConfigError(
        'invalidValue',
        text(
          '这种方式不经登录：客户端直接把变量写进设备设置的 harness.claude-code.env',
          'This method does not sign in: write the variable into harness.claude-code.env in device settings',
        ),
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
      return { kind: 'done', auth: await this.accountState(readProviderSelection()) }
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
    if (providerId === ACCOUNT_PROVIDER) {
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
    const selection = readProviderSelection()
    const envName =
      providerId === API_KEY_PROVIDER
        ? ENV_API_KEY
        : typeof providerId === 'string' && Object.hasOwn(selection.gateways, providerId)
          ? gatewayTokenEnv(providerId)
          : null
    if (!envName)
      throw new HarnessConfigError(
        'notFound',
        text(`没有 provider ${String(providerId)}`, `No provider ${String(providerId)}`),
        'providerId',
      )
    throw new HarnessConfigError(
      'readOnly',
      text(
        `密钥在设备设置里：清掉 harness.claude-code.env 里的 ${envName}`,
        `The key lives in device settings: remove ${envName} from harness.claude-code.env`,
      ),
      'providerId',
    )
  }

  close(): void {
    for (const attempt of this.attempts.values()) attempt.login.cancel()
  }
}
