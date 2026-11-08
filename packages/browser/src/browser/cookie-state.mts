// Electron 的持久分区不恢复会话 Cookie。单独加密保存会话状态，恢复时仍不设置过期时间。
// 不记 Cookie、域名或底层异常；错误消息可能携带凭据。分区键必须保留，不能把 CHIPS 降成普通 Cookie。
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PasswordCipher } from './passwords/store.mjs'

export interface BrowserCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  session: boolean
  expires: number
  sameSite?: 'Strict' | 'Lax' | 'None'
  priority?: 'Low' | 'Medium' | 'High'
  sourceScheme?: 'Unset' | 'NonSecure' | 'Secure'
  sourcePort?: number
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean }
  partitionKeyOpaque?: boolean
}

export interface CookieStateJar {
  read(): Promise<BrowserCookie[]>
  restore(cookie: Record<string, unknown>): Promise<void>
  flush(): Promise<void>
  changed(listener: (removed: boolean) => void): () => void
}

const keyOf = (cookie: BrowserCookie) =>
  JSON.stringify([cookie.domain, cookie.path, cookie.name, cookie.partitionKey ?? null])

export function restorableCookie(cookie: BrowserCookie): Record<string, unknown> | null {
  if (
    cookie?.session !== true ||
    cookie.partitionKeyOpaque ||
    typeof cookie.name !== 'string' ||
    typeof cookie.value !== 'string' ||
    typeof cookie.domain !== 'string' ||
    typeof cookie.path !== 'string'
  )
    return null
  const host = cookie.domain.replace(/^\./, '')
  if (!host || /[\s/\\?#@]/.test(host) || !cookie.path.startsWith('/')) return null
  return {
    name: cookie.name,
    value: cookie.value,
    url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path}`,
    ...(cookie.domain.startsWith('.') ? { domain: cookie.domain } : {}),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    ...(cookie.priority ? { priority: cookie.priority } : {}),
    ...(cookie.sourceScheme ? { sourceScheme: cookie.sourceScheme } : {}),
    ...(cookie.sourcePort !== undefined ? { sourcePort: cookie.sourcePort } : {}),
    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
  }
}

export interface BrowserCookieState {
  flush(): Promise<void>
  clear(removeBrowserData: () => Promise<void>): Promise<void>
  dispose(): void
}

export async function createBrowserCookieState(options: {
  file: string
  cipher: PasswordCipher
  jar: CookieStateJar
  warn(): void
}): Promise<BrowserCookieState> {
  const { file, cipher, jar, warn } = options
  let epoch = 0
  let clearing = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let queue = Promise.resolve()
  const remove = () => {
    for (const path of [file, `${file}.tmp`]) {
      try {
        unlinkSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  const discard = () => {
    try {
      remove()
    } catch {
      warn()
    }
  }
  const save = (cookies: BrowserCookie[]) => {
    if (!cookies.length || !cipher.available()) {
      remove()
      if (cookies.length) warn()
      return
    }
    const sealed = cipher.encrypt(JSON.stringify({ version: 1, cookies }))
    mkdirSync(dirname(file), { recursive: true })
    // 临时文件也只含密文，文件权限不继承默认 umask。
    writeFileSync(`${file}.tmp`, sealed, { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
  try {
    const sealed = readFileSync(file, 'utf8')
    if (!cipher.available()) throw new Error('加密服务不可用')
    const saved = JSON.parse(cipher.decrypt(sealed)) as {
      version?: number
      cookies?: BrowserCookie[]
    }
    if (saved.version !== 1 || !Array.isArray(saved.cookies)) throw new Error('会话状态格式错误')
    const existing = new Set((await jar.read()).map(keyOf))
    for (const cookie of saved.cookies) {
      const details = restorableCookie(cookie)
      if (!details || existing.has(keyOf(cookie))) continue
      try {
        await jar.restore(details)
        existing.add(keyOf(cookie))
      } catch {
        warn()
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      discard()
      warn()
    }
  }

  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer)
    timer = undefined
    const mine = epoch
    const work = queue.then(async () => {
      if (stopped || clearing || mine !== epoch) return
      const cookies = (await jar.read()).filter((cookie) => restorableCookie(cookie) !== null)
      if (stopped || clearing || mine !== epoch) return
      try {
        save(cookies)
      } catch {
        discard()
        warn()
      }
      await jar.flush()
    })
    // 上次读取失败不能卡住下一次保存；失败时删掉旧快照，避免恢复用户已退出的登录。
    queue = work.catch(() => {
      if (mine === epoch) discard()
      warn()
    })
    return queue
  }
  const stop = jar.changed((removed) => {
    if (stopped || clearing) return
    // 注销/覆盖先让旧快照失效，即使随后被强制结束，也不能复活已删除的 Cookie。
    if (removed) {
      epoch++
      discard()
    }
    if (timer) return
    timer = setTimeout(() => {
      void flush()
    }, 250)
    timer.unref?.()
  })
  return {
    flush,
    async clear(removeBrowserData) {
      clearing = true
      epoch++
      if (timer) clearTimeout(timer)
      timer = undefined
      try {
        remove()
        await queue
        await removeBrowserData()
        await jar.flush()
      } finally {
        clearing = false
      }
    },
    dispose() {
      stopped = true
      epoch++
      if (timer) clearTimeout(timer)
      stop()
    },
  }
}
