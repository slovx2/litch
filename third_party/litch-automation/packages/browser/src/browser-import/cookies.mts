// 读取器交来的 Cookie 怎么写进内置浏览器：校验与规范化、和已有的去重（不覆盖）、逐条写入、最后落盘。
// 写入经 CookieJar（产品里是 PARTITION 分区的 session.cookies，见 cookie-jar.mts），这里不引 electron，单测能直接跑。
// 明文值只在这一次调用里经过，不记日志、不进返回值。
import type { ImportedCookie } from './protected-types.mjs'
import type { ImportCounts } from './sinks.mjs'

/** 和 Electron 的 CookiesSetDetails 同形（Electron 44 没有分区键） */
export interface CookieSetDetails {
  url: string
  name: string
  value: string
  domain?: string
  path: string
  secure: boolean
  httpOnly: boolean
  expirationDate?: number
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
}

/** 目标分区里已有的一条，只要去重用的几项 */
export interface ExistingCookie {
  domain?: string | undefined
  hostOnly?: boolean | undefined
  name: string
  path?: string | undefined
}

export interface CookieJar {
  list(): Promise<ExistingCookie[]>
  set(details: CookieSetDetails): Promise<void>
  /** 写完落盘 */
  flush(): Promise<void>
}

export type CookieCheck =
  | { ok: true; key: string; details: CookieSetDetails }
  /** partitioned：分区 Cookie，Electron 写不进分区；invalid：不合规或过期 */
  | { ok: false; reason: 'invalid' | 'partitioned' }

// 控制字符和分号不许出现在名字、值、路径里（Chromium 的 ParsedCookie 同样拒绝）
const CTL_OR_SEMI = /[\u0000-\u001f\u007f;]/
const HOST_NAME = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/
const IPV6 = /^\[[0-9a-f:.]+\]$/
const MAX_NAME_VALUE = 4096
const MAX_PATH = 1024

/** 去重的键：域（含子域的带前导点）、名字、路径 */
const keyOf = (domain: string, hostOnly: boolean, name: string, path: string): string =>
  `${hostOnly ? '' : '.'}${domain}\u0000${name}\u0000${path}`

export function existingKey(cookie: ExistingCookie): string {
  const raw = (cookie.domain ?? '').toLowerCase()
  const hostOnly = cookie.hostOnly ?? !raw.startsWith('.')
  return keyOf(raw.replace(/^\./, ''), hostOnly, cookie.name, cookie.path || '/')
}

/** 校验一条，合规的换成写入的参数。nowSec：现在，Unix 秒 */
export function checkCookie(cookie: ImportedCookie, nowSec: number): CookieCheck {
  const invalid = { ok: false, reason: 'invalid' } as const
  // 读取器交来的不合约（不是对象）也只算这一条无效
  if (!cookie || typeof cookie !== 'object') return invalid
  if (cookie.partitionTopSite) return { ok: false, reason: 'partitioned' }
  const { name, value } = cookie
  if (typeof name !== 'string' || typeof value !== 'string') return invalid
  if (CTL_OR_SEMI.test(name) || name.includes('=') || CTL_OR_SEMI.test(value)) return invalid
  if (name === '' && value === '') return invalid
  if (name.length + value.length > MAX_NAME_VALUE) return invalid

  const rawHost = typeof cookie.host === 'string' ? cookie.host.trim().toLowerCase() : ''
  const hostOnly = !rawHost.startsWith('.')
  const host = rawHost.replace(/^\./, '')
  if (!(HOST_NAME.test(host) || (hostOnly && IPV6.test(host)))) return invalid

  const path = typeof cookie.path === 'string' && cookie.path !== '' ? cookie.path : '/'
  if (!path.startsWith('/') || path.length > MAX_PATH || CTL_OR_SEMI.test(path)) return invalid

  const secure = cookie.secure === true
  const httpOnly = cookie.httpOnly === true
  // 前缀规则（照 Chromium，不分大小写）：__Secure- 要 Secure；__Host- 还要只给这台主机、路径是 /；
  // __Http- 要 Secure 加 HttpOnly；__Host-Http- 是两者都要
  const lower = name.toLowerCase()
  if (lower.startsWith('__secure-') && !secure) return invalid
  if (lower.startsWith('__host-') && !(secure && hostOnly && path === '/')) return invalid
  if (lower.startsWith('__http-') && !(secure && httpOnly)) return invalid
  if (lower.startsWith('__host-http-') && !httpOnly) return invalid
  // SameSite=None 必须带 Secure，否则 Chromium 不收
  if (cookie.sameSite === 'no_restriction' && !secure) return invalid
  const sameSite = ['unspecified', 'no_restriction', 'lax', 'strict'].includes(cookie.sameSite)
    ? cookie.sameSite
    : 'unspecified'

  if (cookie.expires !== undefined) {
    if (typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires)) return invalid
    if (cookie.expires <= nowSec) return invalid
  }

  const details: CookieSetDetails = {
    url: `${secure ? 'https' : 'http'}://${host}${path}`,
    name,
    value,
    path,
    secure,
    httpOnly,
    sameSite,
  }
  // 会话 Cookie 不给过期时间：照样导，重启后丢，和来源一致
  if (cookie.expires !== undefined) details.expirationDate = cookie.expires
  // 只给这台主机的不带 domain；含子域的带上（Electron 会补前导点）
  if (!hostOnly) details.domain = `.${host}`
  return { ok: true, key: keyOf(host, hostOnly, name, path), details }
}

export interface CookieWriteResult extends ImportCounts {
  /** 其中因为是分区 Cookie 跳过的（算在 skippedInvalid 里） */
  partitioned: number
  cancelled: boolean
  /** 写进去了，但落盘失败（Electron 之后还会自己落盘，这次重启前退出可能丢） */
  flushFailed: boolean
}

/** 逐条写入：已有的不覆盖；写的途中取消就停，已写的留着（照样落盘） */
export async function writeCookies(
  cookies: ImportedCookie[],
  jar: CookieJar,
  options: { now: number; signal: AbortSignal },
): Promise<CookieWriteResult> {
  const result: CookieWriteResult = {
    imported: 0,
    skippedExisting: 0,
    skippedInvalid: 0,
    failed: 0,
    partitioned: 0,
    cancelled: false,
    flushFailed: false,
  }
  const nowSec = options.now / 1000
  const existing = new Set((await jar.list()).map(existingKey))
  try {
    for (const cookie of cookies) {
      if (options.signal.aborted) {
        result.cancelled = true
        break
      }
      const check = checkCookie(cookie, nowSec)
      if (!check.ok) {
        result.skippedInvalid += 1
        if (check.reason === 'partitioned') result.partitioned += 1
        continue
      }
      if (existing.has(check.key)) {
        result.skippedExisting += 1
        continue
      }
      try {
        await jar.set(check.details)
        existing.add(check.key)
        result.imported += 1
      } catch {
        // Electron 拒了（公共后缀上的域 Cookie、和已有的安全 Cookie 冲突等）。错误里可能带着值，不往外传
        result.failed += 1
      }
    }
  } finally {
    if (result.imported > 0) {
      try {
        await jar.flush()
      } catch {
        // 已写的照样算数，只在结果里说一句
        result.flushFailed = true
      }
    }
  }
  return result
}
