// 内置浏览器的密码库：`<用户数据>/browser/passwords.json`。每条存站点源、完整地址、用户名、表单字段名、
// 来源和时间；密码交给加密器（主进程里是 Electron 的 safeStorage）加密后存 base64，文件里没有明文。
// 加密器不可用时拒绝存。同源同用户名的已有条目不覆盖，计入“已存在跳过”。
//
// 这里不引 electron：加密器从外面给，单元测试用假的（test/passwords-store.test.mts）。
// 明文只在 importMany 的参数和 reveal 的返回值里经过，不进日志、不进异常信息、不留在这个模块里。
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeOrigin } from './origin.mjs'
import type { ImportCounts, ImportedPassword, PasswordSink } from './types.mjs'

/** 加密器：主进程里包一层 safeStorage（electron.mts），测试里是假的 */
export interface PasswordCipher {
  /** 现在能不能加密 */
  available(): boolean
  /** 加密，回 base64 */
  encrypt(plain: string): string
  /** 解开 base64；解不开就抛 */
  decrypt(sealed: string): string
}

/** 给设置页的一条：没有密码，连加密过的也不给 */
export interface SavedPassword {
  id: string
  origin: string
  username: string
  /** 从哪儿来的，比如 `chrome:Default` */
  source: string
  /** 毫秒：来源里的创建时间，没有就是存进来的时间 */
  createdAt: number
  /** 毫秒：最近一次在内置浏览器里填过；没填过不给 */
  lastUsedAt?: number
}

/** 自动填充的候选：只有编号和用户名 */
export interface PasswordCandidate {
  id: string
  username: string
}

/** 文件里的一条 */
interface StoredEntry {
  id: string
  origin: string
  url?: string
  actionOrigin?: string
  username: string
  usernameField?: string
  passwordField?: string
  /** 加密过的 base64 */
  password: string
  source: string
  store: 'profile' | 'account'
  /** 毫秒 */
  createdAt: number
  importedAt: number
  lastUsedAt?: number
}

/** “这个网站永不保存”的一条 */
export interface NeverSite {
  origin: string
  /** 毫秒 */
  at: number
}

interface StoredFile {
  version: 1
  entries: StoredEntry[]
  /** 用户在保存提示上点了“这个网站永不”的 */
  never?: NeverSite[]
}

/** 一个源上一组用户名和密码跟库里比：没有这个用户名、密码一样、密码不一样 */
export type PasswordMatch = 'none' | 'same' | 'different'

/** 加密器不可用：拒绝存。导入管线接住它，把这一类报成失败，message 就是给人看的说明 */
export class PasswordEncryptionUnavailable extends Error {
  readonly code = 'encryption-unavailable'
  constructor() {
    super(
      'Saved passwords are encrypted with the system keystore, which is not available on this computer, so no passwords were stored.',
    )
    this.name = 'PasswordEncryptionUnavailable'
  }
}

export interface PasswordStore extends PasswordSink {
  /** 设置页的列表 */
  list(): SavedPassword[]
  /** 删一条，回删没删到 */
  remove(id: string): boolean
  /** 全删，回删了几条 */
  removeAll(): number
  /** 这个源（已规范化）的候选 */
  candidates(origin: string): PasswordCandidate[]
  /**
   * 用户点选了一条之后取明文。源对不上、没这条、解不开都回 null。
   * 取到了顺手记一笔最近使用的时间
   */
  reveal(id: string, origin: string): { username: string; password: string } | null
  /** 库变了（导入、保存、删除、永不名单）时通知，回取消的函数 */
  onChange(listener: () => void): () => void
  /** 登录时提交的这一组和库里比（要解开同源同用户名的那一条） */
  compare(origin: string, username: string, password: string): PasswordMatch
  /** 加密一个密码给保存提示暂存；加密器不可用回 null */
  seal(password: string): string | null
  /** 用户在保存提示上点了保存：新的加一条，已有同源同用户名的换掉密码 */
  putSealed(entry: {
    origin: string
    username: string
    sealed: string
    source: string
  }): 'saved' | 'updated'
  /** “这个网站永不保存”的名单 */
  neverSites(): NeverSite[]
  isNever(origin: string): boolean
  addNever(origin: string): void
  /** 从名单里去掉，回去没去掉 */
  removeNever(origin: string): boolean
}

export const passwordsFile = (userData: string): string =>
  join(userData, 'browser', 'passwords.json')

/** 来源里的用户名、密码超过这么长的当无效：多半是坏数据 */
const USERNAME_MAX = 1024
const PASSWORD_MAX = 4096
const FIELD_MAX = 256

const seconds = (value: number | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value * 1000)
    : undefined

const fieldName = (value: string | undefined): string | undefined =>
  typeof value === 'string' && value !== '' && value.length <= FIELD_MAX ? value : undefined

const keyOf = (origin: string, username: string) => `${origin}\u0000${username}`

const isEntry = (value: unknown): value is StoredEntry => {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === 'string' &&
    typeof entry.origin === 'string' &&
    typeof entry.username === 'string' &&
    typeof entry.password === 'string' &&
    typeof entry.source === 'string' &&
    typeof entry.createdAt === 'number'
  )
}

export function createPasswordStore(options: {
  file: string
  cipher: PasswordCipher
  /** 现在几点（毫秒），测试里换掉 */
  now?: () => number
  log?: (line: string) => void
}): PasswordStore {
  const { file, cipher } = options
  const now = options.now ?? Date.now
  const log = options.log ?? (() => {})
  const listeners = new Set<() => void>()
  let entries: StoredEntry[] | null = null
  let never: NeverSite[] = []

  const load = (): StoredEntry[] => {
    if (entries) return entries
    if (!existsSync(file)) {
      entries = []
      return entries
    }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredFile>
      if (!Array.isArray(parsed.entries)) throw new Error('no entries')
      entries = parsed.entries.filter(isEntry)
      never = Array.isArray(parsed.never)
        ? parsed.never.filter(
            (one): one is NeverSite =>
              !!one && typeof one.origin === 'string' && typeof one.at === 'number',
          )
        : []
    } catch {
      // 读不懂的文件挪到一边留着，不在它上面接着写（免得把还能救的东西盖掉）
      const aside = `${file}.broken-${now()}`
      try {
        renameSync(file, aside)
        log(`passwords file was unreadable and moved to ${aside}`)
      } catch {
        log('passwords file was unreadable')
      }
      entries = []
    }
    return entries
  }

  const save = (next: StoredEntry[], nextNever: NeverSite[] = never) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    const body: StoredFile = { version: 1, entries: next, never: nextNever }
    writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, file)
    entries = next
    never = nextNever
    for (const listener of listeners) listener()
  }

  const toSaved = (entry: StoredEntry): SavedPassword => ({
    id: entry.id,
    origin: entry.origin,
    username: entry.username,
    source: entry.source,
    createdAt: entry.createdAt,
    ...(entry.lastUsedAt !== undefined ? { lastUsedAt: entry.lastUsedAt } : {}),
  })

  return {
    async importMany(items: ImportedPassword[], source: string): Promise<ImportCounts> {
      const counts: ImportCounts = { imported: 0, skippedExisting: 0, skippedInvalid: 0, failed: 0 }
      if (items.length === 0) return counts
      if (!cipher.available()) throw new PasswordEncryptionUnavailable()
      const current = load()
      const taken = new Set(current.map((entry) => keyOf(entry.origin, entry.username)))
      const added: StoredEntry[] = []
      const at = now()
      for (const item of items) {
        // 源是空的才拿登录页地址补；给了源却不是网页的（安卓应用等）就是无效
        const origin =
          typeof item.origin === 'string' && item.origin.trim() !== ''
            ? normalizeOrigin(item.origin)
            : typeof item.url === 'string'
              ? normalizeOrigin(item.url)
              : null
        const username = typeof item.username === 'string' ? item.username : null
        const password = typeof item.password === 'string' ? item.password : null
        if (
          !origin ||
          username === null ||
          username.length > USERNAME_MAX ||
          !password ||
          password.length > PASSWORD_MAX
        ) {
          counts.skippedInvalid++
          continue
        }
        const key = keyOf(origin, username)
        if (taken.has(key)) {
          counts.skippedExisting++
          continue
        }
        let sealed: string
        try {
          sealed = cipher.encrypt(password)
        } catch {
          counts.failed++
          continue
        }
        taken.add(key)
        const url = typeof item.url === 'string' && normalizeOrigin(item.url) ? item.url : undefined
        const actionOrigin =
          typeof item.actionOrigin === 'string'
            ? (normalizeOrigin(item.actionOrigin) ?? undefined)
            : undefined
        const usernameField = fieldName(item.usernameField)
        const passwordField = fieldName(item.passwordField)
        const lastUsedAt = seconds(item.lastUsed)
        added.push({
          id: randomUUID(),
          origin,
          ...(url ? { url } : {}),
          ...(actionOrigin ? { actionOrigin } : {}),
          username,
          ...(usernameField ? { usernameField } : {}),
          ...(passwordField ? { passwordField } : {}),
          password: sealed,
          source,
          store: item.store === 'account' ? 'account' : 'profile',
          createdAt: seconds(item.created) ?? at,
          importedAt: at,
          ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
        })
      }
      if (added.length > 0) {
        try {
          save([...current, ...added])
          counts.imported = added.length
        } catch (error) {
          // 写不进去：这一批都算失败。原因里只有文件系统的话，没有明文
          log(`could not write passwords file: ${error instanceof Error ? error.message : error}`)
          counts.failed += added.length
        }
      }
      return counts
    },
    list: () => load().map(toSaved),
    remove(id) {
      const current = load()
      const next = current.filter((entry) => entry.id !== id)
      if (next.length === current.length) return false
      save(next)
      return true
    },
    removeAll() {
      const count = load().length
      if (count > 0 || existsSync(file)) save([])
      return count
    },
    candidates(origin) {
      return load()
        .filter((entry) => entry.origin === origin)
        .sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt))
        .map((entry) => ({ id: entry.id, username: entry.username }))
    },
    reveal(id, origin) {
      const current = load()
      const entry = current.find((one) => one.id === id)
      if (!entry || entry.origin !== origin) return null
      let password: string
      try {
        password = cipher.decrypt(entry.password)
      } catch {
        log('a saved password could not be decrypted')
        return null
      }
      try {
        save(current.map((one) => (one === entry ? { ...one, lastUsedAt: now() } : one)))
      } catch {
        // 记不下最近使用的时间不影响填
      }
      return { username: entry.username, password }
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    compare(origin, username, password) {
      const entry = load().find((one) => one.origin === origin && one.username === username)
      if (!entry) return 'none'
      try {
        return cipher.decrypt(entry.password) === password ? 'same' : 'different'
      } catch {
        // 解不开的旧条目：当作不一样，让用户决定要不要换掉
        return 'different'
      }
    },
    seal(password) {
      if (!cipher.available()) return null
      try {
        return cipher.encrypt(password)
      } catch {
        return null
      }
    },
    putSealed({ origin, username, sealed, source }) {
      const current = load()
      const at = now()
      const existing = current.find((one) => one.origin === origin && one.username === username)
      if (existing) {
        save(current.map((one) => (one === existing ? { ...one, password: sealed } : one)))
        return 'updated'
      }
      save([
        ...current,
        {
          id: randomUUID(),
          origin,
          username,
          password: sealed,
          source,
          store: 'profile',
          createdAt: at,
          importedAt: at,
        },
      ])
      return 'saved'
    },
    neverSites() {
      load()
      return [...never]
    },
    isNever(origin) {
      load()
      return never.some((one) => one.origin === origin)
    },
    addNever(origin) {
      const current = load()
      if (never.some((one) => one.origin === origin)) return
      save(current, [...never, { origin, at: now() }])
    },
    removeNever(origin) {
      const current = load()
      const next = never.filter((one) => one.origin !== origin)
      if (next.length === never.length) return false
      save(current, next)
      return true
    },
  }
}
