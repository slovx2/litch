import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  ImportedCookie,
  ImportedPassword,
  ProtectedKindResult,
  ProtectedReadInput,
} from '../protected-types.mjs'
import {
  decryptLogin,
  decryptPbe,
  loginKeyId,
  passwordKey,
  verifyKeySignature,
} from './nss-crypto.mjs'
import { checkpoint, ReadFault, Records } from './result.mjs'
import { blob, cookieFilter, count, hasTable, origin, rows, sameSite, text, time } from './rows.mjs'
import type { Snapshot } from './snapshot.mjs'

function partition(attributes: string): string | undefined {
  const params = new URLSearchParams(attributes.replace(/^\^/, ''))
  for (const [key, value] of params) {
    // 容器、私密窗口、旧版 firstPartyDomain 没有对应的目标隔离区，不能静默混入普通会话。
    if (key !== 'partitionKey' && value !== '' && value !== '0') throw new ReadFault('unsupported')
  }
  const key = params.get('partitionKey')
  if (!key) return undefined
  const match = /^\((https?),([^,()]+)\)$/.exec(key)
  if (!match) throw new ReadFault('unsupported')
  return `${match[1]}://${match[2]}`
}

export async function firefoxCookies(
  input: ProtectedReadInput,
  snapshot: Snapshot,
): Promise<ProtectedKindResult<ImportedCookie>> {
  const result = new Records<ImportedCookie>()
  let db: DatabaseSync | undefined
  try {
    db = await snapshot.database(join(input.profileDir, 'cookies.sqlite'), input.signal)
    if (!db) return result.finish()
    if (!hasTable(db, 'moz_cookies')) throw new ReadFault('failed')
    result.discovered = count(db, 'moz_cookies')
    const matches = cookieFilter(input.cookieDomains)
    let index = 0
    for (const row of rows(db, 'SELECT * FROM moz_cookies')) {
      if (index++ % 64 === 0) await checkpoint(input.signal)
      if (!matches(row.host)) continue
      try {
        const cookie: ImportedCookie = {
          host: text(row.host),
          name: text(row.name),
          value: text(row.value),
          path: text(row.path),
          secure: !!row.isSecure,
          httpOnly: !!row.isHttpOnly,
          sameSite:
            row.rawSameSite === 0 && row.sameSite === 1 ? 'unspecified' : sameSite(row.sameSite),
        }
        const expires = time(row.expiry, 1)
        const created = time(row.creationTime, 1_000_000)
        const accessed = time(row.lastAccessed, 1_000_000)
        // Firefox 的 SQLite 库持久化的是非会话 Cookie，expiry=0 也应交管线判过期。
        if (row.isSession !== 1 && row.expiry !== undefined) cookie.expires = expires ?? 0
        if (created !== undefined) cookie.created = created
        if (accessed !== undefined) cookie.lastAccessed = accessed
        const top = partition(text(row.originAttributes))
        if (top) cookie.partitionTopSite = top
        result.items.push(cookie)
      } catch (error) {
        result.issue(error, true)
      }
    }
  } catch (error) {
    result.issue(error)
  } finally {
    db?.close()
  }
  return result.finish()
}

class FirefoxKeys {
  private db: DatabaseSync | undefined
  private passKey: Buffer | undefined
  private keys = new Map<string, Buffer>()
  private errors = new Map<string, unknown>()

  async initialize(input: ProtectedReadInput, snapshot: Snapshot): Promise<void> {
    this.db = await snapshot.database(join(input.profileDir, 'key4.db'), input.signal)
    if (!this.db) throw new ReadFault('unsupported')
    const metadata = this.db.prepare("SELECT item1, item2 FROM metadata WHERE id='password'").get()
    if (!metadata) throw new ReadFault('failed')
    this.passKey = passwordKey(blob(metadata.item1))
    let check: Buffer | undefined
    try {
      check = (await decryptPbe(blob(metadata.item2), this.passKey, input.signal)).plain
      if (check.toString('ascii') !== 'password-check') throw new ReadFault('unsupported')
    } catch (error) {
      if (error instanceof ReadFault) throw error
      // 空主密码无法验证；接口不接收主密码，不能冒充授权拒绝。
      throw new ReadFault('unsupported')
    } finally {
      check?.fill(0)
    }
  }

  async get(id: string, signal: AbortSignal): Promise<Buffer> {
    const known = this.keys.get(id)
    if (known) return known
    if (this.errors.has(id)) throw this.errors.get(id)
    try {
      if (!this.db || !this.passKey) throw new ReadFault('failed')
      const record = this.db
        .prepare('SELECT id, a11 FROM nssPrivate WHERE a102=?')
        .get(Buffer.from(id, 'hex'))
      if (!record) throw new ReadFault('failed')
      const decrypted = await decryptPbe(blob(record.a11), this.passKey, signal)
      try {
        if (decrypted.authenticated) {
          const keyId = Number(record.id).toString(16).padStart(8, '0')
          const signature = this.db
            .prepare('SELECT item1 FROM metadata WHERE id=?')
            .get(`sig_key_${keyId}_00000011`)
          if (!signature) throw new ReadFault('failed')
          await verifyKeySignature(blob(signature.item1), decrypted.plain, this.passKey, signal)
        }
        this.keys.set(id, decrypted.plain)
        return decrypted.plain
      } catch (error) {
        decrypted.plain.fill(0)
        throw error
      }
    } catch (error) {
      this.errors.set(id, error)
      throw error
    }
  }

  dispose(): void {
    this.db?.close()
    this.db = undefined
    this.passKey?.fill(0)
    this.passKey = undefined
    for (const key of this.keys.values()) key.fill(0)
    this.keys.clear()
    this.errors.clear()
  }
}

export async function firefoxPasswords(
  input: ProtectedReadInput,
  snapshot: Snapshot,
): Promise<ProtectedKindResult<ImportedPassword>> {
  const result = new Records<ImportedPassword>()
  const keys = new FirefoxKeys()
  try {
    const path = await snapshot.file(join(input.profileDir, 'logins.json'), input.signal)
    if (!path) return result.finish()
    const data = await readFile(path)
    let logins: unknown
    try {
      logins = JSON.parse(data.toString('utf8'))?.logins
    } finally {
      data.fill(0)
    }
    if (!Array.isArray(logins)) throw new ReadFault('failed')
    result.discovered = logins.length
    if (!logins.length) return result.finish()
    try {
      await keys.initialize(input, snapshot)
    } catch (error) {
      result.failed = result.discovered
      throw error
    }
    for (const [index, value] of logins.entries()) {
      if (index % 64 === 0) await checkpoint(input.signal)
      try {
        if (!value || typeof value !== 'object') throw new ReadFault('failed')
        const row = value as Record<string, unknown>
        const user = text(row.encryptedUsername)
        const secret = text(row.encryptedPassword)
        const username = decryptLogin(user, await keys.get(loginKeyId(user), input.signal))
        const password = decryptLogin(secret, await keys.get(loginKeyId(secret), input.signal))
        const item: ImportedPassword = {
          origin: origin(text(row.hostname)),
          url: text(row.hostname),
          username,
          password,
          store: 'profile',
          usernameField: text(row.usernameField),
          passwordField: text(row.passwordField),
        }
        if (text(row.formSubmitURL)) item.actionOrigin = origin(text(row.formSubmitURL))
        const created = time(row.timeCreated, 1000)
        const used = time(row.timeLastUsed, 1000)
        if (created !== undefined) item.created = created
        if (used !== undefined) item.lastUsed = used
        result.items.push(item)
      } catch (error) {
        result.issue(error, true)
      }
    }
  } catch (error) {
    result.issue(error)
  } finally {
    keys.dispose()
  }
  return result.finish()
}
