// 所有 REST 读取共用固定版本及凭据配额；生产调用方不能改主机。
export const GITHUB_API_VERSION = '2022-11-28'
const githubApi = 'https://api.github.com'
export type JsonObject = Record<string, unknown>
export interface GithubRepository {
  repoId: string
  owner: string
  name: string
}

export type GithubFaultKind =
  | 'authentication'
  | 'permission'
  | 'not-found'
  | 'repository-changed'
  | 'disabled'
  | 'primary-rate'
  | 'secondary-rate'
  | 'transient'
  | 'invalid-response'

export class GithubFault extends Error {
  readonly kind: GithubFaultKind
  readonly retryAt: number | undefined
  constructor(kind: GithubFaultKind, retryAt?: number) {
    super(`GitHub: ${kind}`)
    this.kind = kind
    this.retryAt = retryAt
  }
}

export function parseGithubJson(raw: string): unknown {
  try {
    return JSON.parse(raw, (key, value: unknown, context?: { source?: string }) => {
      // JS 数值已经舍入；标识只取 JSON 的原始数字字面量。
      if (typeof value === 'number' && (key === 'id' || key.endsWith('_id'))) {
        return context?.source && /^[0-9]+$/.test(context.source) ? context.source : null
      }
      return value
    }) as unknown
  } catch {
    throw new GithubFault('invalid-response')
  }
}

export function githubId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : undefined
}

export function githubNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export function githubObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
}

export function githubTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value))
    return
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}

export function githubLogin(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^(?:[a-z\d]+(?:-[a-z\d]+)*)(?:\[bot\])?$/i.test(value) &&
    value.length <= 44
    ? value
    : undefined
}

export function githubRepoPath(repo: GithubRepository): string {
  if (
    !githubId(repo.repoId) ||
    !githubLogin(repo.owner) ||
    !/^[a-z\d_.-]{1,100}$/i.test(repo.name) ||
    repo.name === '.' ||
    repo.name === '..'
  )
    throw new TypeError('Invalid GitHub repository')
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
}

export function githubSubjectNumber(
  raw: unknown,
  repo: GithubRepository,
  family: 'issues' | 'pulls',
): number | undefined {
  if (typeof raw !== 'string') return
  try {
    const url = new URL(raw)
    if (url.origin !== githubApi || url.username || url.password || url.search || url.hash) return
    const prefix = githubRepoPath(repo)
    const path = url.pathname.toLowerCase()
    for (const base of [prefix.toLowerCase(), `/repositories/${repo.repoId}`]) {
      const root = `${base}/${family}/`
      if (path.startsWith(root) && /^[1-9]\d*$/.test(path.slice(root.length))) {
        return githubNumber(Number(path.slice(root.length)))
      }
    }
  } catch {
    return
  }
}

export function githubPermalink(repo: GithubRepository, path: string): string {
  return `https://github.com${githubRepoPath(repo).slice('/repos'.length)}/${path}`
}

export interface GithubResponse {
  status: 200 | 304
  body: unknown
  headers: Headers
  serverTime: number
}

// 一份实例对应一个凭据代，跨仓库和各只读探针共享。
export interface GithubApi {
  generation: string
  now(): number
  get(path: string, etag?: string): Promise<GithubResponse>
}

interface GithubApiOptions {
  token: string
  generation: string
  now?: () => number
  jitter?: () => number
}

export function createGithubApi(options: GithubApiOptions): GithubApi {
  return githubApiAt(githubApi, options)
}

export function githubApiForLoopbackTest(origin: string, options: GithubApiOptions): GithubApi {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(origin))
    throw new TypeError('Expected loopback fixture')
  return githubApiAt(origin, options)
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const value = headers.get(name)
  return value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : undefined
}

function retryAfter(headers: Headers, now: number, serverTime: number): number {
  const seconds = headerNumber(headers, 'retry-after')
  if (seconds !== undefined) return now + seconds * 1000
  const date = Date.parse(headers.get('retry-after') ?? '')
  return Number.isFinite(date) ? now + Math.max(0, date - serverTime) : now
}

async function boundedBody(response: Response, limit: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > limit) throw new GithubFault('invalid-response')
      parts.push(part.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(parts, size).toString('utf8')
}

function githubApiAt(origin: string, options: GithubApiOptions): GithubApi {
  const { token, generation, now = Date.now, jitter = Math.random } = options
  if (!token.trim() || /[\s\u0000-\u001f]/.test(token) || !generation)
    throw new TypeError('Invalid GitHub credential')
  let blocked: GithubFault | undefined
  let strikes = 0
  let lastSecondary = Number.NEGATIVE_INFINITY
  // 二级限额也约束同一凭据的并发；只读调用不并行打出。
  let tail: Promise<unknown> = Promise.resolve()
  async function request(path: string, etag?: string): Promise<GithubResponse> {
    if (!path.startsWith('/') || path.startsWith('//') || /[\\#\r\n]/.test(path))
      throw new TypeError('Invalid GitHub API path')
    const url = new URL(path, origin)
    if (url.origin !== origin) throw new TypeError('Invalid GitHub API origin')
    if (blocked && (blocked.retryAt === undefined || now() < blocked.retryAt)) throw blocked
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': GITHUB_API_VERSION,
          ...(etag ? { 'if-none-match': etag } : {}),
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      })
      const time = now()
      const date = Date.parse(response.headers.get('date') ?? '')
      const serverTime = Number.isFinite(date) ? date : time
      const remaining = headerNumber(response.headers, 'x-ratelimit-remaining')
      const reset = headerNumber(response.headers, 'x-ratelimit-reset')
      const retry = retryAfter(response.headers, time, serverTime)
      const primary = remaining === 0
      if (primary) {
        const wait = reset !== undefined ? Math.max(1000, reset * 1000 - serverTime) : 60_000
        blocked = new GithubFault('primary-rate', Math.max(retry, time + wait))
      }
      if (response.status === 200 || response.status === 304) {
        return {
          status: response.status,
          body:
            response.status === 200
              ? parseGithubJson(await boundedBody(response, 32 * 1024 * 1024))
              : undefined,
          serverTime,
          headers: response.headers,
        }
      }
      if (response.status === 401) {
        await response.body?.cancel()
        blocked = new GithubFault('authentication')
        throw blocked
      }
      if (response.status === 403 || response.status === 429) {
        const body = await boundedBody(response, 64 * 1024)
        if (primary && blocked) throw blocked
        if (
          response.status === 429 ||
          response.headers.has('retry-after') ||
          /secondary rate limit|abuse detection/i.test(body)
        ) {
          if (time - lastSecondary > 60 * 60_000) strikes = 0
          lastSecondary = time
          const delay = Math.min(60_000 * 2 ** strikes, 60 * 60_000)
          strikes = Math.min(strikes + 1, 6)
          blocked = new GithubFault(
            'secondary-rate',
            Math.max(retry, time + delay * (1 + 0.25 * jitter())),
          )
          throw blocked
        }
        throw new GithubFault('permission')
      }
      await response.body?.cancel()
      if (response.status === 404) throw new GithubFault('not-found')
      if (response.status === 410) throw new GithubFault('disabled')
      if ([301, 302, 307, 308].includes(response.status))
        throw new GithubFault('repository-changed')
      if (response.status >= 500) throw new GithubFault('transient', Math.max(retry, time + 30_000))
      throw new GithubFault('invalid-response')
    } catch (error) {
      if (error instanceof GithubFault) throw error
      throw new GithubFault('transient', now() + 30_000)
    }
  }
  return {
    generation,
    now,
    get(path, etag) {
      const next = tail.then(() => request(path, etag))
      tail = next.catch(() => undefined)
      return next
    },
  }
}

export async function verifyGithubRepository(
  api: GithubApi,
  repo: GithubRepository,
): Promise<GithubResponse> {
  const response = await api.get(githubRepoPath(repo))
  const object = githubObject(response.body)
  if (
    githubId(object.id) !== repo.repoId ||
    typeof object.full_name !== 'string' ||
    object.full_name.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase()
  ) {
    throw new GithubFault('repository-changed')
  }
  return response
}
