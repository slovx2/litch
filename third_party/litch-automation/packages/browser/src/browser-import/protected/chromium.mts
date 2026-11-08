import { createHash, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  ImportedCookie,
  ImportedPassword,
  ProtectedKindResult,
  ProtectedReadInput,
} from '../protected-types.mjs'
import type { ChromiumCrypto } from './chromium-crypto.mjs'
import { checkCancelled, checkpoint, ReadFault, Records } from './result.mjs'
import {
  blob,
  cookieFilter,
  count,
  hasTable,
  origin,
  rows,
  sameSite,
  text,
  unixChrome,
} from './rows.mjs'
import type { Snapshot } from './snapshot.mjs'

export async function chromiumCookies(
  input: ProtectedReadInput,
  snapshot: Snapshot,
  crypto: ChromiumCrypto,
): Promise<ProtectedKindResult<ImportedCookie>> {
  const result = new Records<ImportedCookie>()
  let db: DatabaseSync | undefined
  try {
    // Windows 的库在 Network 下，macOS 及部分 Chromium 派生版在资料根目录。
    db =
      (await snapshot.database(join(input.profileDir, 'Network', 'Cookies'), input.signal)) ??
      (await snapshot.database(join(input.profileDir, 'Cookies'), input.signal))
    if (!db) return result.finish()
    if (!hasTable(db, 'cookies')) throw new ReadFault('failed')
    result.discovered = count(db, 'cookies')
    const version = hasTable(db, 'meta')
      ? Number(db.prepare("SELECT value FROM meta WHERE key='version'").get()?.value)
      : 0
    const matches = cookieFilter(input.cookieDomains)
    let index = 0
    for (const row of rows(db, 'SELECT * FROM cookies')) {
      if (index++ % 64 === 0) await checkpoint(input.signal)
      if (!matches(row.host_key)) continue
      try {
        let value = text(row.value)
        const encrypted = blob(row.encrypted_value)
        if (encrypted.length) {
          const plain = await crypto.decrypt(encrypted)
          try {
            let offset = 0
            if (version >= 24) {
              const digest = createHash('sha256').update(text(row.host_key)).digest()
              if (plain.length < 32 || !timingSafeEqual(digest, plain.subarray(0, 32)))
                throw new ReadFault('failed')
              offset = 32
            }
            value = plain.subarray(offset).toString('utf8')
          } finally {
            plain.fill(0)
          }
        }
        const cookie: ImportedCookie = {
          host: text(row.host_key),
          name: text(row.name),
          value,
          path: text(row.path),
          secure: !!row.is_secure,
          httpOnly: !!row.is_httponly,
          sameSite: sameSite(row.samesite),
        }
        const expires = unixChrome(row.expires_utc)
        const created = unixChrome(row.creation_utc)
        const accessed = unixChrome(row.last_access_utc)
        if (row.has_expires !== 0 && row.is_persistent !== 0) {
          // 持久 Cookie 的零/非法到期时间也交管线判，不能变成无到期时间的会话 Cookie。
          cookie.expires = expires ?? Number(row.expires_utc) / 1_000_000 - 11_644_473_600
        }
        if (created !== undefined) cookie.created = created
        if (accessed !== undefined) cookie.lastAccessed = accessed
        if (text(row.top_frame_site_key)) cookie.partitionTopSite = text(row.top_frame_site_key)
        result.items.push(cookie)
      } catch (error) {
        result.issue(error, true)
      }
    }
    checkCancelled(input.signal)
  } catch (error) {
    result.issue(error)
  } finally {
    db?.close()
  }
  return result.finish()
}

export async function chromiumPasswords(
  input: ProtectedReadInput,
  snapshot: Snapshot,
  crypto: ChromiumCrypto,
): Promise<ProtectedKindResult<ImportedPassword>> {
  const result = new Records<ImportedPassword>()
  for (const [filename, store] of [
    ['Login Data', 'profile'],
    ['Login Data For Account', 'account'],
  ] as const) {
    let db: DatabaseSync | undefined
    try {
      checkCancelled(input.signal)
      db = await snapshot.database(join(input.profileDir, filename), input.signal)
      if (!db) continue
      if (!hasTable(db, 'logins')) throw new ReadFault('failed')
      result.discovered += count(db, 'logins')
      let index = 0
      for (const row of rows(db, 'SELECT * FROM logins')) {
        if (index++ % 64 === 0) await checkpoint(input.signal)
        try {
          const encrypted = blob(row.password_value)
          const plain = encrypted.length ? await crypto.decrypt(encrypted) : Buffer.alloc(0)
          try {
            const password: ImportedPassword = {
              // 拒绝保存的网站没有凭据；把空源交给管线计入无效跳过。
              origin: row.blacklisted_by_user ? '' : origin(text(row.origin_url)),
              url: text(row.origin_url),
              username: text(row.username_value),
              password: plain.toString('utf8'),
              store,
              usernameField: text(row.username_element),
              passwordField: text(row.password_element),
            }
            if (text(row.action_url)) password.actionOrigin = origin(text(row.action_url))
            const created = unixChrome(row.date_created)
            const used = unixChrome(row.date_last_used)
            if (created !== undefined) password.created = created
            if (used !== undefined) password.lastUsed = used
            result.items.push(password)
          } finally {
            plain.fill(0)
          }
        } catch (error) {
          result.issue(error, true)
        }
      }
    } catch (error) {
      result.issue(error)
    } finally {
      db?.close()
    }
  }
  return result.finish()
}
