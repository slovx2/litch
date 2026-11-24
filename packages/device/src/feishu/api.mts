// 飞书开放平台的精简 REST 客户端：应用身份令牌的缓存与刷新、错误分类、超时。
// 生产地址固定；测试只能经 feishuEndpointsForLoopbackTest 换成回环上的假服务端。

export interface FeishuEndpoints {
  /** 开放平台接口与长连接配置 */
  open: string
  /** 创建向导的设备注册接口（不带应用身份，见 registration.mts） */
  accounts: string
}

export const FEISHU_PRODUCTION: FeishuEndpoints = {
  open: 'https://open.feishu.cn',
  accounts: 'https://accounts.feishu.cn',
}

export function feishuEndpointsForLoopbackTest(origin: string): FeishuEndpoints {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(origin))
    throw new TypeError('Expected loopback fixture')
  return { open: origin, accounts: origin }
}

export type FeishuApiErrorKind =
  | 'credential_rejected'
  | 'permission'
  | 'not_found'
  | 'rate_limited'
  | 'network'
  | 'platform'
  | 'invalid'

export class FeishuApiError extends Error {
  readonly kind: FeishuApiErrorKind
  readonly code: number | undefined
  readonly status: number | undefined
  /** 限流时最早可以重试的时间（毫秒） */
  readonly retryAt: number | undefined
  constructor(
    kind: FeishuApiErrorKind,
    detail: { code?: number; status?: number; retryAt?: number } = {},
  ) {
    super(`feishu_${kind}${detail.code === undefined ? '' : `_${detail.code}`}`)
    this.kind = kind
    this.code = detail.code
    this.status = detail.status
    this.retryAt = detail.retryAt
  }
}

// 令牌无效或过期：作废缓存重取一次
const TOKEN_INVALID = new Set([99991661, 99991663, 99991668])
// 没开权限或权限没生效
const PERMISSION = new Set([99991672, 99991679])
const RATE_LIMITED = new Set([99991400, 11232])
const NOT_FOUND = new Set([230001, 230002, 230011, 232011, 232025, 234003])

const RESPONSE_LIMIT = 8 * 1024 * 1024

interface FeishuBody {
  code?: unknown
  msg?: unknown
  data?: unknown
  [key: string]: unknown
}

export interface FeishuRequest {
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  form?: FormData
  timeoutMs?: number
}

export interface FeishuApiOptions {
  fetch?: typeof fetch
  /** 毫秒 */
  now?: () => number
}

export class FeishuApi {
  readonly appId: string
  private readonly endpoints: FeishuEndpoints
  private readonly secret: () => string
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  private cached: { token: string; expiresAt: number } | null = null
  private pending: Promise<string> | null = null

  constructor(
    endpoints: FeishuEndpoints,
    appId: string,
    secret: () => string,
    options: FeishuApiOptions = {},
  ) {
    this.endpoints = endpoints
    this.appId = appId
    this.secret = secret
    this.fetcher = options.fetch ?? fetch
    this.now = options.now ?? Date.now
  }

  invalidate(): void {
    this.cached = null
  }

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached.token
    this.pending ??= this.fetchToken().finally(() => {
      this.pending = null
    })
    return await this.pending
  }

  private async fetchToken(): Promise<string> {
    const body = await this.raw('POST', '/open-apis/auth/v3/tenant_access_token/internal', {
      body: { app_id: this.appId, app_secret: this.secret() },
    })
    if (body.code !== 0) {
      throw new FeishuApiError(
        typeof body.code === 'number' && body.code >= 10000 && body.code < 20000
          ? 'credential_rejected'
          : 'platform',
        typeof body.code === 'number' ? { code: body.code } : {},
      )
    }
    const token = typeof body.tenant_access_token === 'string' ? body.tenant_access_token : ''
    const expire = typeof body.expire === 'number' ? body.expire : 0
    if (!token) throw new FeishuApiError('platform')
    // 提前 5 分钟过期，至少留 30 秒
    this.cached = { token, expiresAt: this.now() + Math.max(30, expire - 300) * 1000 }
    return token
  }

  /** 调接口，返回整个响应体（code 为 0 时）；失败抛 FeishuApiError */
  async call(method: string, path: string, request: FeishuRequest = {}): Promise<FeishuBody> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.token()
      const body = await this.raw(method, path, request, token)
      const code = typeof body.code === 'number' ? body.code : -1
      if (code === 0) return body
      if (TOKEN_INVALID.has(code) && attempt === 0) {
        this.invalidate()
        continue
      }
      throw classify(code, body)
    }
  }

  /** 调接口，返回 data 字段 */
  async data<T = Record<string, unknown>>(
    method: string,
    path: string,
    request: FeishuRequest = {},
  ): Promise<T> {
    const body = await this.call(method, path, request)
    return (body.data ?? {}) as T
  }

  /** 下载文件类接口：返回字节 */
  async download(
    path: string,
    query: FeishuRequest['query'] = {},
    limit = 64 * 1024 * 1024,
  ): Promise<{ bytes: Buffer; type: string }> {
    const token = await this.token()
    const response = await this.send(
      'GET',
      this.url(this.endpoints.open, path, query),
      { authorization: `Bearer ${token}` },
      undefined,
      120_000,
    )
    const type = response.headers.get('content-type') ?? ''
    if (!response.ok || type.includes('application/json')) {
      const body = parse((await bounded(response, RESPONSE_LIMIT)).toString('utf8'))
      throw classify(typeof body.code === 'number' ? body.code : -1, body, response.status)
    }
    return { bytes: await bounded(response, limit), type }
  }

  /**
   * CLI 代理用：原样转发一个请求（路径带查询，字节不动），只换上应用令牌。
   * JSON 响应先读完（令牌失效时作废缓存重取一次）；其余的（下载文件等）交回流。
   */
  async forward(
    method: string,
    pathAndQuery: string,
    headers: Record<string, string>,
    body: Buffer | undefined,
    /** 用户身份：用这个 token，不用应用令牌（失效时由授权那边处理，这里不重试） */
    userToken?: string,
  ): Promise<{
    status: number
    headers: Headers
    json?: { bytes: Buffer; code: number | undefined; data: unknown }
    stream?: ReadableStream<Uint8Array> | null
  }> {
    if (!pathAndQuery.startsWith('/')) throw new FeishuApiError('invalid')
    for (let attempt = 0; ; attempt++) {
      const token = userToken ?? (await this.token())
      const response = await this.send(
        method,
        `${this.endpoints.open}${pathAndQuery}`,
        { ...headers, authorization: `Bearer ${token}` },
        body === undefined || body.length === 0 ? undefined : new Uint8Array(body),
        120_000,
      )
      if (!(response.headers.get('content-type') ?? '').includes('application/json'))
        return { status: response.status, headers: response.headers, stream: response.body }
      const bytes = await bounded(response, RESPONSE_LIMIT)
      const parsed = parse(bytes.toString('utf8'))
      const code = typeof parsed.code === 'number' ? parsed.code : undefined
      if (code !== undefined && TOKEN_INVALID.has(code) && attempt === 0 && !userToken) {
        this.invalidate()
        continue
      }
      return {
        status: response.status,
        headers: response.headers,
        json: { bytes, code, data: parsed.data },
      }
    }
  }

  private async raw(
    method: string,
    path: string,
    request: FeishuRequest,
    token?: string,
  ): Promise<FeishuBody> {
    const headers: Record<string, string> = {}
    if (token) headers.authorization = `Bearer ${token}`
    let payload: RequestInit['body']
    if (request.form) payload = request.form
    else if (request.body !== undefined) {
      headers['content-type'] = 'application/json; charset=utf-8'
      payload = JSON.stringify(request.body)
    }
    const response = await this.send(
      method,
      this.url(this.endpoints.open, path, request.query ?? {}),
      headers,
      payload,
      request.timeoutMs ?? 30_000,
    )
    const body = parse((await bounded(response, RESPONSE_LIMIT)).toString('utf8'))
    if (response.status === 429) {
      const reset = Number(response.headers.get('x-ogw-ratelimit-reset') ?? '')
      throw new FeishuApiError('rate_limited', {
        status: 429,
        retryAt: this.now() + (Number.isFinite(reset) && reset > 0 ? reset * 1000 : 5_000),
      })
    }
    if (response.status >= 500 && body.code === undefined)
      throw new FeishuApiError('network', { status: response.status })
    return body
  }

  private url(base: string, path: string, query: NonNullable<FeishuRequest['query']>): string {
    const url = new URL(path, base)
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value))
    return url.toString()
  }

  private async send(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: RequestInit['body'],
    timeoutMs: number,
  ): Promise<Response> {
    try {
      return await this.fetcher(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new FeishuApiError('network')
    }
  }
}

function classify(code: number, _body: FeishuBody, status?: number): FeishuApiError {
  const detail = { code, ...(status === undefined ? {} : { status }) }
  if (RATE_LIMITED.has(code))
    return new FeishuApiError('rate_limited', { ...detail, retryAt: Date.now() + 5_000 })
  if (PERMISSION.has(code)) return new FeishuApiError('permission', detail)
  if (NOT_FOUND.has(code)) return new FeishuApiError('not_found', detail)
  if (TOKEN_INVALID.has(code)) return new FeishuApiError('credential_rejected', detail)
  return new FeishuApiError('platform', detail)
}

function parse(text: string): FeishuBody {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as FeishuBody) : {}
  } catch {
    return {}
  }
}

async function bounded(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new FeishuApiError('invalid')
    }
    parts.push(value)
  }
  return Buffer.concat(parts)
}
