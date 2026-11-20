// 仅设备模块能构造路径；生产固定 GitHub.com，测试只能显式选用回环。
import { createHash } from 'node:crypto'

const origin = 'https://api.github.com'
export const GITHUB_WRITE_API_VERSION = '2022-11-28'
export type JsonObject = Record<string, unknown>
export const object = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
export const numericId = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[1-9]\d{0,30}$/.test(value)
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : undefined
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
export const login = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z\d]+(?:-[a-z\d]+)*$/i.test(value) && value.length <= 39
export const repoName = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z\d_.-]{1,100}$/i.test(value) && value !== '.' && value !== '..'
export const isFineGrainedToken = (token: unknown): token is string =>
  typeof token === 'string' && /^github_pat_[A-Za-z0-9_]{20,255}$/.test(token)
export function redactGithubSecrets(text: string): string {
  return text.replace(/(?:github_pat_|gh[pousr]_)[a-z\d_]{15,}/gi, '[已移除凭据]')
}

export class GithubWriteFault extends Error {
  readonly code: string
  readonly status: number | undefined
  readonly retryAt: number | undefined
  readonly requestId: string | undefined
  constructor(code: string, status?: number, retryAt?: number, requestId?: string) {
    super(code)
    this.code = code
    this.status = status
    this.retryAt = retryAt
    this.requestId = requestId
  }
}

export function parseExternalGithubJson(text: string): unknown {
  try {
    return JSON.parse(text, (key, value: unknown, context?: { source?: string }) =>
      typeof value === 'number' && (key === 'id' || key.endsWith('_id') || key === 'number')
        ? (numericId(context?.source) ?? null)
        : value,
    ) as unknown
  } catch {
    throw new GithubWriteFault('github_invalid_response')
  }
}

export interface GithubWriteResponse {
  body: unknown
  status: number
  requestId?: string
  next: boolean
  expiresAt?: number
}
export type GithubSender = (
  token: string,
  path: string,
  options?: { post?: object; method?: 'PATCH'; beforeDispatch?: () => void },
) => Promise<GithubWriteResponse>

function transport(api: string): GithubSender {
  return async (token, path, options) => {
    if (!/^\/(?!\/)[a-z\d_.~/%?=&:+,-]+$/i.test(path) || !isFineGrainedToken(token))
      throw new GithubWriteFault('github_request_invalid')
    const url = new URL(path, api)
    if (url.origin !== api) throw new GithubWriteFault('github_request_invalid')
    options?.beforeDispatch?.()
    let response: Response
    try {
      response = await fetch(url, {
        method: options?.post ? (options.method ?? 'POST') : 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': GITHUB_WRITE_API_VERSION,
          ...(options?.post ? { 'content-type': 'application/json' } : {}),
        },
        ...(options?.post ? { body: JSON.stringify(options.post) } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      throw new GithubWriteFault('github_transport_unknown')
    }
    const status = response.status
    const rawRequestId = response.headers.get('x-github-request-id')
    const requestId =
      rawRequestId && /^[a-f\d:]{1,100}$/i.test(rawRequestId) ? rawRequestId : undefined
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after')
      const primary = response.headers.get('x-ratelimit-remaining') === '0'
      const now = Math.floor(Date.now() / 1000)
      const reset = Number(response.headers.get('x-ratelimit-reset') ?? 0)
      const retryAt =
        retryAfter && /^\d{1,6}$/.test(retryAfter)
          ? now + Number(retryAfter)
          : primary && Number.isSafeInteger(reset)
            ? Math.max(reset, now + 1)
            : now + 60
      const orgApproval = response.headers.has('x-github-sso')
      let secondary = false
      if (status === 403 && !orgApproval && !primary && !retryAfter) {
        const body = await responseText(response, 65536).catch(() => '')
        secondary = /secondary rate limit|abuse detection/i.test(body)
      } else await response.body?.cancel().catch(() => undefined)
      const fault = (code: string, at?: number) => new GithubWriteFault(code, status, at, requestId)
      if (status === 429 || (status === 403 && (primary || retryAfter || secondary)))
        throw fault('github_rate_limited', retryAt)
      if (status === 401) throw fault('github_credential_invalid')
      if (orgApproval) throw fault('github_organization_approval_required')
      if (status === 403) throw fault('github_permission_denied')
      if (status === 404) throw fault('github_target_unavailable')
      if (status === 422) throw fault('github_validation_rejected')
      if (status >= 300 && status < 400) throw fault('github_redirect_denied')
      throw fault('github_request_unknown')
    }
    const expiresAt = Date.parse(
      response.headers.get('github-authentication-token-expiration') ?? '',
    )
    return {
      body: parseExternalGithubJson(await responseText(response)),
      status,
      next: /;\s*rel="next"/.test(response.headers.get('link') ?? ''),
      ...(requestId ? { requestId } : {}),
      ...(Number.isFinite(expiresAt) ? { expiresAt: Math.floor(expiresAt / 1000) } : {}),
    }
  }
}

async function responseText(response: Response, limit = 8 * 1024 * 1024): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new GithubWriteFault('github_invalid_response')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      length += result.value.byteLength
      if (length > limit) throw new GithubWriteFault('github_invalid_response')
      chunks.push(result.value)
    }
    return Buffer.concat(chunks, length).toString('utf8')
  } catch {
    throw new GithubWriteFault('github_invalid_response')
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
export const sendGithub: GithubSender = transport(origin)
export function githubWriterForLoopbackTest(address: string): GithubSender {
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(address))
    throw new Error('github_writer_requires_loopback')
  return transport(address)
}

export async function githubPages(
  get: (path: string) => Promise<GithubWriteResponse>,
  path: string,
  project: (body: unknown) => unknown = (body) => body,
  limit = 10,
): Promise<JsonObject[]> {
  const records: JsonObject[] = []
  for (let page = 1; page <= limit; page++) {
    const response = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    const values = project(response.body)
    if (!Array.isArray(values)) throw new GithubWriteFault('github_invalid_response')
    records.push(...values.map(object))
    if (!response.next) return records
  }
  throw new GithubWriteFault('github_page_limit')
}

export function githubRepoPath(repo: { owner: string; name: string; repoId: string }): string {
  if (!login(repo.owner) || !repoName(repo.name) || !numericId(repo.repoId))
    throw new GithubWriteFault('github_repository_invalid')
  return `/repos/${repo.owner}/${repo.name}`
}
