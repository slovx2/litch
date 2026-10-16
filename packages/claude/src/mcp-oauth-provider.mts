import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthCredential } from './mcp-oauth-store.mjs'

export class OAuthLoginRequired extends Error {
  constructor() {
    super('MCP 服务需要 OAuth 登录')
  }
}

function secureUrl(value: string): URL {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
  )
    throw new Error('OAuth 端点必须使用 HTTPS 或本机回环 HTTP')
  return url
}

// 发现结果在提交凭据前绑定资源及 issuer，后续刷新不能悄悄更换授权服务器。
export function validateOAuthDiscovery(
  state: OAuthDiscoveryState,
  previous: OAuthDiscoveryState | undefined,
  resource: string,
): void {
  const issuer = secureUrl(String(state.authorizationServerUrl))
  const metadata = state.authorizationServerMetadata
  if (!metadata || secureUrl(metadata.issuer).href !== issuer.href)
    throw new Error('OAuth issuer 不匹配')
  if (previous && secureUrl(String(previous.authorizationServerUrl)).href !== issuer.href)
    throw new Error('OAuth issuer 已变化，需要重新授权')
  for (const endpoint of [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.registration_endpoint,
  ])
    if (endpoint) secureUrl(endpoint)
  const requested = new URL(resource)
  const declared = state.resourceMetadata?.resource
  if (declared) {
    const candidate = secureUrl(declared)
    const prefix = candidate.pathname.replace(/\/$/, '')
    if (
      candidate.origin !== requested.origin ||
      (requested.pathname !== prefix && !requested.pathname.startsWith(prefix + '/'))
    )
      throw new Error('OAuth 保护资源不匹配')
  }
}

export class StoredOAuthProvider implements OAuthClientProvider {
  readonly record: OAuthCredential
  private verifier = ''
  authorizationUrl: string | undefined
  readonly redirectUrl: string
  private readonly stateValue: string | undefined
  private readonly scopes: string[] | undefined

  constructor(
    record: OAuthCredential,
    redirectUrl: string,
    stateValue?: string,
    scopes?: string[],
  ) {
    this.record = structuredClone(record)
    this.redirectUrl = redirectUrl
    this.stateValue = stateValue
    this.scopes = scopes
  }

  get clientMetadata() {
    return {
      client_name: 'Tyrs Hand Claude MCP',
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(this.scopes ? { scope: this.scopes.join(' ') } : {}),
    }
  }

  state(): string {
    if (!this.stateValue) throw new OAuthLoginRequired()
    return this.stateValue
  }
  clientInformation() {
    return this.record.client
  }
  saveClientInformation(value: NonNullable<OAuthCredential['client']>) {
    this.record.client = value
  }
  tokens() {
    return this.record.tokens
  }
  saveTokens(value: OAuthTokens): void {
    // 刷新响应可省略不变的 refresh_token；交互授权没有旧 token 可继承。
    this.record.tokens = {
      ...value,
      ...(value.refresh_token
        ? {}
        : this.record.tokens?.refresh_token
          ? { refresh_token: this.record.tokens.refresh_token }
          : {}),
    }
    if (value.expires_in === undefined) delete this.record.expiresAt
    else this.record.expiresAt = Date.now() + value.expires_in * 1000
    this.record.redirectUrl = this.redirectUrl
  }
  redirectToAuthorization(value: URL): void {
    if (!this.stateValue) throw new OAuthLoginRequired()
    secureUrl(value.href)
    this.authorizationUrl = value.href
  }
  saveCodeVerifier(value: string): void {
    this.verifier = value
  }
  codeVerifier(): string {
    if (!this.verifier) throw new Error('OAuth PKCE 校验器不存在')
    return this.verifier
  }
  discoveryState() {
    return this.record.discovery
  }
  saveDiscoveryState(value: OAuthDiscoveryState): void {
    validateOAuthDiscovery(value, this.record.discovery, this.record.binding.url)
    this.record.discovery = value
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'tokens') {
      delete this.record.tokens
      delete this.record.expiresAt
    }
    if (scope === 'all' || scope === 'client') delete this.record.client
    if (scope === 'all' || scope === 'discovery') delete this.record.discovery
    if (scope === 'all' || scope === 'verifier') this.verifier = ''
  }
}

// 不把 MCP 的业务请求头带到发现、注册或 token 端点，也不自动跟随凭据重定向。
export function oauthFetch(signal: AbortSignal): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    secureUrl(request.url)
    const response = await fetch(request, {
      redirect: 'error',
      signal: AbortSignal.any([signal, request.signal]),
    })
    return response
  }
}
