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

/** 读到了、写过了的一类：按失败条数定 ok、partial、failed */
function finished(
  discovered: number,
  counts: ImportCounts,
  options: { cancelled?: boolean; error?: string | undefined },
): ImportKindOutcome {
  const handled = counts.imported + counts.skippedExisting + counts.skippedInvalid
  const status = options.cancelled
    ? 'cancelled'
    : counts.failed === 0
      ? 'ok'
      : handled > 0
        ? 'partial'
        : 'failed'
  const outcome: ImportKindOutcome = { ...counts, status, discovered }
  if (options.error) outcome.error = options.error
  return outcome
}

/** 规范化“只导这些网站的 Cookie”：小写、去掉前导和末尾的点，网址取主机名，认不出的丢掉；空的当没给 */
export function normalizeDomains(list: readonly string[] | undefined): string[] | undefined {
  if (!list) return undefined
  const out = new Set<string>()
  for (const raw of list.slice(0, 1000)) {
    if (typeof raw !== 'string') continue
    let text = raw.trim().toLowerCase()
    if (text.includes('://')) {
      try {
        text = new URL(text).hostname
      } catch {
        continue
      }
    }
    text = text.replace(/^\.+/, '').replace(/\.+$/, '')
    if (/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(text)) out.add(text)
  }
  return out.size > 0 ? [...out] : undefined
}

export const domainMatches = (host: string, domains: readonly string[]): boolean => {
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
  isWebUrl(item.origin) &&
  typeof item.username === 'string' &&
  typeof item.password === 'string' &&
  item.password !== ''

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

    // Cookie 和密码一次读：Mac 上只弹一次钥匙串
    const protectedKinds: ProtectedKind[] = wanted.filter((kind) => available.has(kind))
    let read: ProtectedReadResult = {}
    if (protectedKinds.length > 0) {
      for (const kind of protectedKinds) progress({ kind, phase: 'reading' })
      const cookieDomains = normalizeDomains(request.cookieDomains)
      try {
        read = await options.reader.read({
          browser: source.browser,
          family: source.family,
          root: source.root,
          profileDir: profile.dir,
          kinds: protectedKinds,
          ...(cookieDomains ? { cookieDomains } : {}),
          allowElevated: request.allowElevated === true,
          signal,
        })
      } catch {
        // 读取器约定不抛；万一抛了，异常里可能有什么都不知道，一概不往外传
        read = {}
      }
      for (const item of read.cookies?.items ?? []) if (item.value) secrets.add(item.value)
      for (const item of read.passwords?.items ?? []) if (item.password) secrets.add(item.password)

      if (protectedKinds.includes('cookies')) {
        kinds.cookies = await importCookies(read.cookies, cookieDomains, signal, secrets, progress)
      }
      if (protectedKinds.includes('passwords')) {
        kinds.passwords = await importPasswords(read.passwords, tag, signal, secrets, progress)
      }
      // 明文用完就丢（读取器交来的数组要是冻住了清不掉，就只丢引用）
      try {
        if (read.cookies) read.cookies.items.length = 0
        if (read.passwords) read.passwords.items.length = 0
      } catch {}
      read = {}
    }

    secrets.clear()
    return { kinds }
  }

  async function importCookies(
    result: ProtectedKindResult<ImportedCookie> | undefined,
    domains: string[] | undefined,
    signal: AbortSignal,
    secrets: ReadonlySet<string>,
    progress: (progress: ImportProgress) => void,
  ): Promise<ImportKindOutcome> {
    try {
      if (!result) return notRead('failed', 0, 'The reader returned no result.')
      const error = scrub(result.error, secrets)
      if (result.status !== 'ok' && result.status !== 'partial') {
        return notRead(result.status, result.discovered, error)
      }
      if (signal.aborted) return notRead('cancelled', result.discovered, error)
      // 读取器该按域名筛过；再筛一遍，筛掉的不算数
      const items = domains
        ? result.items.filter((item) => domainMatches(item.host, domains))
        : result.items
      const discovered = Math.max(0, result.discovered - (result.items.length - items.length))
      progress({ kind: 'cookies', phase: 'writing' })
      let written: Awaited<ReturnType<typeof writeCookies>>
      try {
        written = await writeCookies(items, options.cookies, { now: now(), signal })
      } catch {
        return notRead('failed', discovered, 'Could not write to the built-in browser.')
      }
      const { partitioned, cancelled, ...counts } = written
      return finished(
        discovered,
        { ...counts, failed: counts.failed + result.failed },
        {
          cancelled,
          error: joinErrors(
            error,
            partitioned > 0
              ? `${partitioned} partitioned cookie(s) skipped: the built-in browser cannot store partitioned cookies.`
              : undefined,
            counts.failed > 0
              ? `${counts.failed} cookie(s) were rejected by the built-in browser.`
              : undefined,
          ),
        },
      )
    } finally {
      progress({ kind: 'cookies', phase: 'done' })
    }
  }

  async function importPasswords(
    result: ProtectedKindResult<ImportedPassword> | undefined,
    tag: string,
    signal: AbortSignal,
    secrets: ReadonlySet<string>,
    progress: (progress: ImportProgress) => void,
  ): Promise<ImportKindOutcome> {
    try {
      const sink = options.passwords
      if (!result) return notRead('failed', 0, 'The reader returned no result.')
      const error = scrub(result.error, secrets)
      if (result.status !== 'ok' && result.status !== 'partial') {
        return notRead(result.status, result.discovered, error)
      }
      if (!sink) return notRead('unsupported', result.discovered, error)
      // 写 Cookie 的时候取消了：密码读到了但没轮上写
      if (signal.aborted) return notRead('skipped', result.discovered, error)
      const valid = result.items.filter(validPassword)
      const invalid = result.items.length - valid.length
      progress({ kind: 'passwords', phase: 'writing' })
      let counts: ImportCounts
      try {
        counts = valid.length > 0 ? await sink.importMany(valid, tag) : EMPTY_COUNTS
      } catch (sinkError) {
        const message = scrub(sinkError instanceof Error ? sinkError.message : undefined, secrets)
        counts = { ...EMPTY_COUNTS, failed: valid.length }
        return finished(
          result.discovered,
          { ...counts, failed: counts.failed + result.failed, skippedInvalid: invalid },
          {
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
        { error },
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
        // 算“导过”：全成了，或者部分成了而且确实有东西进去（导入的、本来就有的）
        const succeeded = IMPORT_KINDS.filter((kind) => {
          const item = outcome.kinds[kind]
          if (item?.status === 'ok') return true
          return item?.status === 'partial' && item.imported + item.skippedExisting > 0
        })
        options.state.imported(succeeded, now())
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
      options.state.dismissBanner(now())
    },
  }
}
