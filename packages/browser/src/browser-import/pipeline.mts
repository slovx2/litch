// 导入管线：列来源、按请求导入一次、取消、记“导过没有”。不引 electron：Cookie 经 CookieJar 写，
// 密码经 sinks.mts 的 PasswordSink 交出去，读 Cookie 和密码经读取器（protected-types.mts）。
//
// 明文（Cookie 的值、密码）只在 start 这一次调用的栈里：读取器交来、校验、写进去，之后就丢；不进日志，
// 不进返回值（界面只拿到条数和状态），给人看的那句话里要是带着明文也换掉（scrub）。
import { browserDef, type ImportEnv } from './browsers.mjs'
import { type CookieJar, writeCookies } from './cookies.mjs'
import { discoverSources, type FoundProfile, type FoundSource, findProfile } from './discover.mjs'
import type {
  ImportedCookie,
  ImportedPassword,
  ProtectedCapabilities,
  ProtectedKind,
  ProtectedKindResult,
  ProtectedReader,
  ProtectedReadResult,
  ProtectedStatus,
} from './protected-types.mjs'
import type { ImportCounts, PasswordSink } from './sinks.mjs'
import type { ImportStateBook } from './state.mjs'
import {
  IMPORT_KINDS,
  type ImportKind,
  type ImportKindOutcome,
  type ImportOutcome,
  type ImportProgress,
  type ImportRequest,
  type ImportSource,
  type ImportState,
} from './types.mjs'

export interface ImporterOptions {
  /** 每次发现都重新取（测试里换成假的主目录） */
  env: () => ImportEnv
  reader: ProtectedReader
  cookies: CookieJar
  /** 没有就导不了密码（密码库还没接上） */
  passwords?: PasswordSink
  state: ImportStateBook
  now?: () => number
  /** 只记条数和状态 */
  log?: (line: string) => void
}

export interface Importer {
  sources(): ImportSource[]
  /** 一次只一个：已经有一个在跑就回 busy */
  start(
    request: ImportRequest,
    onProgress?: (progress: ImportProgress) => void,
  ): Promise<ImportOutcome>
  /** 取消正在跑的那一个；没有就什么都不做 */
  cancel(): void
  running(): boolean
  state(): ImportState
  dismissBanner(): void
}

const EMPTY_COUNTS: ImportCounts = { imported: 0, skippedExisting: 0, skippedInvalid: 0, failed: 0 }

const MAX_ERROR = 300

/** 给人看的一句话：太长截断；里面要是带着这一次读到的任何明文，整句换掉 */
function scrub(text: string | undefined, secrets: ReadonlySet<string>): string | undefined {
  if (!text) return undefined
  for (const secret of secrets) {
    if (secret.length >= 4 && text.includes(secret)) return 'Details withheld.'
  }
  return text.length > MAX_ERROR ? `${text.slice(0, MAX_ERROR)}…` : text
}

const joinErrors = (...parts: (string | undefined)[]): string | undefined => {
  const text = parts.filter((part): part is string => !!part).join(' ')
  return text === '' ? undefined : text
}

/** 读取器在一类上没读成（不是 ok、partial）时的结果 */
const notRead = (
  status: ImportKindOutcome['status'],
  discovered = 0,
  error?: string,
): ImportKindOutcome => {
  const outcome: ImportKindOutcome = { ...EMPTY_COUNTS, status, discovered }
  if (error) outcome.error = error
  return outcome
}

/**
 * 读到了、写过了的一类：按失败条数定 ok、partial、failed。reader 是读取器报的状态（ok 或 partial），
 * 最终的不能比它好：读取器报 partial 时哪怕 failed 是 0（库级的失败只给了 error）也不报 ok
 */
function finished(
  discovered: number,
  counts: ImportCounts,
  options: { cancelled?: boolean; error?: string | undefined; reader?: ProtectedStatus },
): ImportKindOutcome {
  const handled = counts.imported + counts.skippedExisting + counts.skippedInvalid
  const computed = options.cancelled
    ? 'cancelled'
    : counts.failed === 0
      ? 'ok'
      : handled > 0
        ? 'partial'
        : 'failed'
  const status = computed === 'ok' && options.reader === 'partial' ? 'partial' : computed
  const outcome: ImportKindOutcome = { ...counts, status, discovered }
  if (options.error) outcome.error = options.error
  return outcome
}

const DOMAIN = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/

/** 人写的一个网站：网址取主机名；URL 顺带转小写、把国际化域名转成 punycode（Cookie 库里存的就是它）；认不出是 null */
function domainOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim().replace(/^\*\./, '')
  if (text === '') return null
  let host: string
  try {
    host = new URL(text.includes('://') ? text : `http://${text}`).hostname
  } catch {
    return null
  }
  host = host.replace(/^\.+/, '').replace(/\.+$/, '')
  return DOMAIN.test(host) ? host : null
}

/**
 * 规范化“只导这些网站的 Cookie”。没给或给了空数组是 undefined（全部）；
 * 给了却一个都认不出是 null：这一类直接拒，绝不退化成全导
 */
export function normalizeDomains(
  list: readonly unknown[] | undefined,
): string[] | undefined | null {
  if (!list || list.length === 0) return undefined
  const out = new Set<string>()
  for (const raw of list.slice(0, 1000)) {
    const host = domainOf(raw)
    if (host) out.add(host)
  }
  return out.size > 0 ? [...out] : null
}

export const domainMatches = (host: unknown, domains: readonly string[]): boolean => {
  if (typeof host !== 'string') return false
  const bare = host.trim().toLowerCase().replace(/^\./, '')
  return domains.some((domain) => bare === domain || bare.endsWith(`.${domain}`))
}

const isWebUrl = (text: unknown): boolean => {
  if (typeof text !== 'string') return false
  try {
    const { protocol } = new URL(text)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** 密码交给密码库之前的筛选：非网页的（安卓应用等）、没有密码的算“无效跳过” */
const validPassword = (item: ImportedPassword): boolean =>
  !!item &&
  typeof item === 'object' &&
  isWebUrl(item.origin) &&
  typeof item.username === 'string' &&
  typeof item.password === 'string' &&
  item.password !== ''

const READER_STATUSES: readonly ProtectedStatus[] = [
  'ok',
  'partial',
  'missing',
  'locked',
  'denied',
  'needs-elevation',
  'unsupported',
  'cancelled',
  'failed',
]

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined

/**
 * 读取器交来的一类结果按合约整理一遍：不是对象、状态不认识、读成了却没有条目数组的，算不合约（null）；
 * 数字不对的按条目补上，error 不是字符串的丢掉
 */
function saneResult<T>(raw: unknown): ProtectedKindResult<T> | null {
  if (!raw || typeof raw !== 'object') return null
  const result = raw as Record<string, unknown>
  const status = READER_STATUSES.find((item) => item === result.status)
  if (!status) return null
  const read = status === 'ok' || status === 'partial'
  if (read && !Array.isArray(result.items)) return null
  const items = read ? (result.items as T[]) : []
  const failed = count(result.failed) ?? 0
  const out: ProtectedKindResult<T> = {
    status,
    discovered: count(result.discovered) ?? items.length + failed,
    items,
    failed,
  }
  if (typeof result.error === 'string') out.error = result.error
  return out
}

/** 读取器交来的条目数组（不合约的当没有），收明文用 */
const itemsOf = (raw: unknown): unknown[] =>
  raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)
    ? (raw as { items: unknown[] }).items
    : []

function safeCapabilities(reader: ProtectedReader, source: FoundSource): ProtectedCapabilities {
  try {
    const caps = reader.capabilities(source.browser)
    return {
      promptsSystemAuth: caps.promptsSystemAuth === true,
      needsElevation: caps.needsElevation === true,
      kinds: Array.isArray(caps.kinds) ? caps.kinds : [],
    }
  } catch {
    return { promptsSystemAuth: false, needsElevation: false, kinds: [] }
  }
}

export function createImporter(options: ImporterOptions): Importer {
  const now = options.now ?? Date.now
  const log = options.log ?? (() => {})
  let current: AbortController | null = null

  /** 这个来源在这台机器上能导哪几类 */
  const kindsOf = (caps: ProtectedCapabilities): ImportKind[] =>
    IMPORT_KINDS.filter(
      (kind) => caps.kinds.includes(kind) && (kind === 'cookies' || !!options.passwords),
    )

  const toProfile = (profile: FoundProfile) => {
    const out: ImportSource['profiles'][number] = {
      id: profile.id,
      name: profile.name,
      isDefault: profile.isDefault,
      has: { ...profile.has },
    }
    if (profile.account) out.account = profile.account
    return out
  }

  async function run(
    request: ImportRequest,
    found: { source: FoundSource; profile: FoundProfile },
    signal: AbortSignal,
    progress: (progress: ImportProgress) => void,
  ): Promise<ImportOutcome> {
    const { source, profile } = found
    const caps = safeCapabilities(options.reader, source)
    const available = new Set(kindsOf(caps))
    const wanted = IMPORT_KINDS.filter((kind) => request.kinds.includes(kind))
    const kinds: ImportOutcome['kinds'] = {}
    const tag = `${source.browser}:${profile.id}`
    const secrets = new Set<string>()

    for (const kind of wanted) {
      if (!available.has(kind)) kinds[kind] = notRead('unsupported')
    }

    // “只导这些网站”给了却一个都认不出：Cookie 这一类直接拒，绝不退化成全导
    const cookieDomains = normalizeDomains(request.cookieDomains)
    let readable: ProtectedKind[] = wanted.filter((kind) => available.has(kind))
    if (cookieDomains === null && readable.includes('cookies')) {
      kinds.cookies = notRead('failed', 0, 'None of the requested cookie domains is valid.')
      readable = readable.filter((kind) => kind !== 'cookies')
    }

    // Cookie 和密码一次读：Mac 上只弹一次钥匙串
    if (readable.length > 0) {
      for (const kind of readable) progress({ kind, phase: 'reading' })
      let read: ProtectedReadResult = {}
      try {
        read = await options.reader.read({
          browser: source.browser,
          family: source.family,
          root: source.root,
          profileDir: profile.dir,
          kinds: readable,
          ...(cookieDomains ? { cookieDomains } : {}),
          allowElevated: request.allowElevated === true,
          signal,
        })
      } catch {
        // 读取器约定不抛；万一抛了，异常里可能有什么都不知道，一概不往外传
        read = {}
      }
      // 读的时候就取消了（读取器没理 signal、照常交了结果也算）
      const cancelledWhileReading = signal.aborted
      const raw = (read && typeof read === 'object' ? read : {}) as Record<string, unknown>
      for (const item of itemsOf(raw.cookies)) {
        const value = (item as { value?: unknown } | null)?.value
        if (typeof value === 'string' && value) secrets.add(value)
      }
      for (const item of itemsOf(raw.passwords)) {
        const password = (item as { password?: unknown } | null)?.password
        if (typeof password === 'string' && password) secrets.add(password)
      }

      if (readable.includes('cookies')) {
        kinds.cookies = await guarded('cookies', progress, () =>
          importCookies(raw.cookies, cookieDomains ?? undefined, signal, secrets, progress),
        )
      }
      if (readable.includes('passwords')) {
        kinds.passwords = await guarded('passwords', progress, () =>
          importPasswords(raw.passwords, tag, signal, cancelledWhileReading, secrets, progress),
        )
      }
      // 明文用完就丢（读取器交来的数组要是冻住了清不掉，就只丢引用）
      for (const items of [itemsOf(raw.cookies), itemsOf(raw.passwords)]) {
        try {
          items.length = 0
        } catch {}
      }
    }

    secrets.clear()
    return { kinds }
  }

  /** 一类导入里出了没料到的错（读取器交来的东西不合约等）：这一类 failed，别的照常 */
  async function guarded(
    kind: ImportKind,
    progress: (progress: ImportProgress) => void,
    work: () => Promise<ImportKindOutcome>,
  ): Promise<ImportKindOutcome> {
    try {
      return await work()
    } catch {
      progress({ kind, phase: 'done' })
      return notRead('failed', 0, 'Unexpected error while importing.')
    }
  }

  async function importCookies(
    raw: unknown,
    domains: string[] | undefined,
    signal: AbortSignal,
    secrets: ReadonlySet<string>,
    progress: (progress: ImportProgress) => void,
  ): Promise<ImportKindOutcome> {
    try {
      if (raw === undefined) return notRead('failed', 0, 'The reader returned no result.')
      const result = saneResult<ImportedCookie>(raw)
      if (!result) return notRead('failed', 0, 'The reader returned a malformed result.')
      const error = scrub(result.error, secrets)
      if (result.status !== 'ok' && result.status !== 'partial') {
        return notRead(result.status, result.discovered, error)
      }
      if (signal.aborted) return notRead('cancelled', result.discovered, error)
      // 读取器该按域名筛过；再筛一遍，筛掉的不算数（主机不是字符串的留着，写的时候算无效）
      const items = domains
        ? result.items.filter(
            (item) => typeof item?.host !== 'string' || domainMatches(item.host, domains),
          )
        : result.items
      const discovered = Math.max(0, result.discovered - (result.items.length - items.length))
      progress({ kind: 'cookies', phase: 'writing' })
      let written: Awaited<ReturnType<typeof writeCookies>>
      try {
        written = await writeCookies(items, options.cookies, { now: now(), signal })
      } catch {
        return notRead('failed', discovered, 'Could not write to the built-in browser.')
      }
      const { partitioned, cancelled, flushFailed, ...counts } = written
      return finished(
        discovered,
        { ...counts, failed: counts.failed + result.failed },
        {
          cancelled,
          reader: result.status,
          error: joinErrors(
            error,
            partitioned > 0
              ? `${partitioned} partitioned cookie(s) skipped: the built-in browser cannot store partitioned cookies.`
              : undefined,
            counts.failed > 0
              ? `${counts.failed} cookie(s) were rejected by the built-in browser.`
              : undefined,
            flushFailed ? 'Cookies were written but could not be flushed to disk.' : undefined,
          ),
        },
      )
    } finally {
      progress({ kind: 'cookies', phase: 'done' })
    }
  }

  async function importPasswords(
    raw: unknown,
    tag: string,
    signal: AbortSignal,
    cancelledWhileReading: boolean,
    secrets: ReadonlySet<string>,
    progress: (progress: ImportProgress) => void,
  ): Promise<ImportKindOutcome> {
    try {
      const sink = options.passwords
      if (raw === undefined) return notRead('failed', 0, 'The reader returned no result.')
      const result = saneResult<ImportedPassword>(raw)
      if (!result) return notRead('failed', 0, 'The reader returned a malformed result.')
      const error = scrub(result.error, secrets)
      if (result.status !== 'ok' && result.status !== 'partial') {
        return notRead(result.status, result.discovered, error)
      }
      if (!sink) return notRead('unsupported', result.discovered, error)
      // 读的时候取消的是 cancelled；写 Cookie 的时候取消的，密码读到了但没轮上写，是 skipped
      if (signal.aborted) {
        return notRead(cancelledWhileReading ? 'cancelled' : 'skipped', result.discovered, error)
      }
      const valid = result.items.filter(validPassword)
      const invalid = result.items.length - valid.length
      progress({ kind: 'passwords', phase: 'writing' })
      let counts: ImportCounts
      try {
        counts = valid.length > 0 ? await sink.importMany(valid, tag) : EMPTY_COUNTS
      } catch (sinkError) {
        const message = scrub(sinkError instanceof Error ? sinkError.message : undefined, secrets)
        return finished(
          result.discovered,
          { ...EMPTY_COUNTS, failed: valid.length + result.failed, skippedInvalid: invalid },
          {
            reader: result.status,
            error: joinErrors(error, message ?? 'The password store failed.'),
          },
        )
      } finally {
        valid.length = 0
      }
      return finished(
        result.discovered,
        {
          ...counts,
          skippedInvalid: counts.skippedInvalid + invalid,
          failed: counts.failed + result.failed,
        },
        { reader: result.status, error },
      )
    } finally {
      progress({ kind: 'passwords', phase: 'done' })
    }
  }

  return {
    sources() {
      const env = options.env()
      return discoverSources(env).map((source) => {
        const caps = safeCapabilities(options.reader, source)
        return {
          browser: source.browser,
          name: source.name,
          kinds: kindsOf(caps),
          promptsSystemAuth: caps.promptsSystemAuth,
          needsElevation: caps.needsElevation,
          profiles: source.profiles.map(toProfile),
        }
      })
    },
    async start(request, onProgress) {
      if (current) return { error: 'busy', kinds: {} }
      if (!browserDef(request.browser)) return { error: 'profile-gone', kinds: {} }
      const controller = new AbortController()
      current = controller
      try {
        const found = findProfile(options.env(), request.browser, request.profileId)
        if (!found) return { error: 'profile-gone', kinds: {} }
        const progress = (item: ImportProgress) => {
          try {
            onProgress?.(item)
          } catch {
            // 报进度失败不影响导入
          }
        }
        const outcome = await run(request, found, controller.signal, progress)
        // 算“导过”：成了（ok 或 partial），而且确实有东西在里面了（导入的、本来就有的）；一条都没进去的不算，横幅照出
        const succeeded = IMPORT_KINDS.filter((kind) => {
          const item = outcome.kinds[kind]
          if (item?.status !== 'ok' && item?.status !== 'partial') return false
          return item.imported + item.skippedExisting > 0
        })
        try {
          options.state.imported(succeeded, now())
        } catch {
          // 记不下来不影响这次导入的结果，只说一句
          log('could not save the import state')
          for (const kind of succeeded) {
            const item = outcome.kinds[kind]
            if (!item) continue
            const error = joinErrors(item.error, 'Could not record the import time.')
            if (error) item.error = error
          }
        }
        log(
          `import ${request.browser}: ${Object.entries(outcome.kinds)
            .map(
              ([kind, item]) =>
                `${kind} ${item.status} ${item.imported}/${item.skippedExisting}/${item.skippedInvalid}/${item.failed}`,
            )
            .join(', ')}`,
        )
        return outcome
      } finally {
        if (current === controller) current = null
      }
    },
    cancel() {
      current?.abort()
    },
    running: () => current !== null,
    state: () => options.state.state(),
    dismissBanner() {
      try {
        options.state.dismissBanner(now())
      } catch {
        // 存不下来：这次运行里照样算关了（状态簿先改内存再存盘）
        log('could not save the banner state')
      }
    },
  }
}
