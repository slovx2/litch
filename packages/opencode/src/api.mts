import { compatibilityHint } from './versions.mjs'

// opencode serve 的 v1 HTTP 接口的最小客户端。本文件和 runtime.mts 是仅有的两处直接接触线路形状的地方。
// 鉴权用 HTTP Basic（用户名 opencode，密码是适配器每次拉起时随机生成的 OPENCODE_SERVER_PASSWORD）。
// 会话相关的请求都带 x-opencode-directory：一个 serve 管全部目录，按这个头把请求路由到对应目录的实例。

export class OpencodeError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface RequestOptions {
  directory?: string | null | undefined
  query?: Record<string, string | number | boolean | undefined> | undefined
  body?: unknown
  signal?: AbortSignal | undefined
  // 等多久没有应答就放弃（毫秒）；默认不限。发起回合、压缩这类会一直跑到回合结束的请求不设。
  timeoutMs?: number | undefined
}

// 连接层的失败（连不上、对面把连接关了）fetch 只说一句 fetch failed，是哪一种在 cause 里。
function unreachable(what: string, error: unknown): OpencodeError {
  const cause: any = (error as any)?.cause ?? error
  const detail = [cause?.code, cause?.message].filter(Boolean).join(' ') || String(error)
  return new OpencodeError(0, `${what}：和 OpenCode 的连接出了问题（${detail}）`)
}

// OpenCode 的错误应答是 JSON：{name, data: {message}} 或 {message}，也可能是纯文字。
function failure(status: number, text: string): string {
  try {
    const body = JSON.parse(text)
    const message = body?.data?.message ?? body?.message ?? body?.error?.message ?? body?.name
    if (typeof message === 'string' && message) return message
  } catch {}
  return text.trim().slice(0, 600) || `HTTP ${status}`
}

export class OpencodeApi {
  readonly url: string
  readonly version: string
  private readonly authorization: string

  constructor(url: string, password: string, version: string) {
    this.url = url.replace(/\/$/, '')
    this.version = version
    this.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  }

  // 头里的目录 OpenCode 按 URL 编码读（它的 instance-context 中间件先解码），中文、空格都要编码，和它的 SDK 一样。
  headers(directory?: string | null): Record<string, string> {
    return {
      authorization: this.authorization,
      ...(directory ? { 'x-opencode-directory': encodeURIComponent(directory) } : {}),
    }
  }

  async request<T = any>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.url + path)
    for (const [key, value] of Object.entries(options.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value))
    const signals = [
      options.signal,
      options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : null,
    ]
    const signal = AbortSignal.any(signals.filter((value): value is AbortSignal => Boolean(value)))
    const what = `${method} ${path}`
    const response = await fetch(url, {
      method,
      headers: {
        ...this.headers(options.directory),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? null : JSON.stringify(options.body),
      signal,
    }).catch((error) => {
      throw unreachable(what, error)
    })
    const text = await response.text().catch(() => '')
    if (response.status === 404 && /^<!doctype|^Not Found$/i.test(text.trim()))
      throw new OpencodeError(
        404,
        `OpenCode 没有 ${what} 这个接口。${compatibilityHint(this.version)}`,
      )
    if (!response.ok)
      throw new OpencodeError(response.status, `${what}: ${failure(response.status, text)}`)
    if (!text) return null as T
    try {
      return JSON.parse(text) as T
    } catch {
      return text as T
    }
  }
}
