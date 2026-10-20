import { createCipheriv, createHash, createHmac, pbkdf2Sync } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SystemSecrets } from '../chromium-crypto.mjs'
import type { ProtectedReadInput } from '../../protected-types.mjs'

export const safeStorage = 'sample safe storage'
export const winKey = Buffer.alloc(32, 0x27)
export const secrets: SystemSecrets = {
  async keychain() {
    return Buffer.from(safeStorage)
  },
  async unprotect() {
    return Buffer.from(winKey)
  },
}
export async function fixture(family: 'chromium' | 'firefox' = 'chromium') {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'litch-reader-fixture-'))
  const profileDir = join(root, 'profile with 空格')
  await mkdir(profileDir)
  const input: ProtectedReadInput = {
    root,
    profileDir,
    browser: family === 'firefox' ? 'firefox' : 'chrome',
    family,
    kinds: ['cookies', 'passwords'],
    allowElevated: false,
    signal: new AbortController().signal,
  }
  return {
    input,
    async dispose() {
      await rm(root, { recursive: true, force: true })
    },
  }
}
export function chromeTime(unix: number): number {
  return (unix + 11_644_473_600) * 1_000_000
}
export function encryptedMac(value: string | Buffer): Buffer {
  const key = pbkdf2Sync(safeStorage, 'saltysalt', 1003, 16, 'sha1')
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 32))
  return Buffer.concat([Buffer.from('v10'), cipher.update(value), cipher.final()])
}
export function encryptedWin(value: string | Buffer): Buffer {
  const iv = Buffer.alloc(12, 0x19)
  const cipher = createCipheriv('aes-256-gcm', winKey, iv)
  return Buffer.concat([
    Buffer.from('v10'),
    iv,
    cipher.update(value),
    cipher.final(),
    cipher.getAuthTag(),
  ])
}
export function domainValue(host: string, value: string): Buffer {
  return Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(value)])
}
export function chromeCookies(input: ProtectedReadInput, version = 24): DatabaseSync {
  const db = new DatabaseSync(join(input.profileDir, 'Cookies'))
  db.exec(`CREATE TABLE meta (key TEXT, value TEXT);
    CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB,
    path TEXT DEFAULT '/', is_secure INTEGER DEFAULT 1, is_httponly INTEGER DEFAULT 1,
    samesite INTEGER DEFAULT 1, expires_utc INTEGER DEFAULT 0, has_expires INTEGER DEFAULT 0,
    is_persistent INTEGER DEFAULT 0, creation_utc INTEGER DEFAULT 0, last_access_utc INTEGER DEFAULT 0,
    top_frame_site_key TEXT DEFAULT '');`)
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('version', String(version))
  return db
}
export function addCookie(
  db: DatabaseSync,
  host = '.example.com',
  value = 'cookie fixture',
  encrypt = encryptedMac,
): void {
  db.prepare('INSERT INTO cookies(host_key,name,value,encrypted_value) VALUES(?,?,?,?)').run(
    host,
    'sid',
    '',
    encrypt(domainValue(host, value)),
  )
}
export function chromePasswords(input: ProtectedReadInput, account = false): DatabaseSync {
  const db = new DatabaseSync(
    join(input.profileDir, account ? 'Login Data For Account' : 'Login Data'),
  )
  db.exec(`CREATE TABLE logins(origin_url TEXT, action_url TEXT, username_value TEXT, password_value BLOB,
    username_element TEXT DEFAULT 'user', password_element TEXT DEFAULT 'pass',
    date_created INTEGER DEFAULT 0, date_last_used INTEGER DEFAULT 0, blacklisted_by_user INTEGER DEFAULT 0);`)
  return db
}
export async function localState(input: ProtectedReadInput): Promise<void> {
  await writeFile(
    join(input.root, 'Local State'),
    JSON.stringify({
      os_crypt: { encrypted_key: Buffer.from('DPAPIsample encrypted key').toString('base64') },
    }),
  )
}
export function firefoxCookies(input: ProtectedReadInput): DatabaseSync {
  const db = new DatabaseSync(join(input.profileDir, 'cookies.sqlite'))
  db.exec(`CREATE TABLE moz_cookies(host TEXT, name TEXT, value TEXT, path TEXT DEFAULT '/',
    isSecure INTEGER DEFAULT 1, isHttpOnly INTEGER DEFAULT 1, sameSite INTEGER DEFAULT 0,
    rawSameSite INTEGER DEFAULT 0, expiry INTEGER DEFAULT 1700000000, creationTime INTEGER DEFAULT 1700000000000000,
    lastAccessed INTEGER DEFAULT 1700000000000000, originAttributes TEXT DEFAULT '');`)
  return db
}

// 独立构造 ASN.1 样本，不引用读取器的 DER、KDF、字段解析代码。
function der(tag: number, data: Buffer): Buffer {
  const size =
    data.length < 128
      ? Buffer.from([data.length])
      : data.length < 256
        ? Buffer.from([0x81, data.length])
        : Buffer.from([0x82, data.length >> 8, data.length & 255])
  return Buffer.concat([Buffer.from([tag]), size, data])
}
const sequence = (...items: Buffer[]) => der(0x30, Buffer.concat(items))
const octet = (data: Buffer) => der(4, data)
const objectId = (hex: string) => der(6, Buffer.from(hex, 'hex'))
const number = (value: number) => der(2, Buffer.from([value]))
const salt = Buffer.alloc(32, 0x39)
const globalSalt = Buffer.alloc(20, 0x45)
const keyId = Buffer.from('f8000000000000000000000000000001', 'hex')
const loginKey = Buffer.alloc(24, 0x61)
const kdfSpec = (size: number) =>
  sequence(
    objectId('2a864886f70d01050c'),
    sequence(
      octet(salt),
      number(1),
      number(size),
      sequence(objectId('2a864886f70d0209'), der(5, Buffer.alloc(0))),
    ),
  )

function pbe(value: Buffer, master = ''): Buffer {
  const passKey = createHash('sha1').update(globalSalt).update(master).digest()
  const key = pbkdf2Sync(passKey, salt, 1, 32, 'sha256')
  const iv = Buffer.concat([Buffer.from([4, 14]), Buffer.alloc(14, 0x32)])
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  return sequence(
    sequence(
      objectId('2a864886f70d01050d'),
      sequence(kdfSpec(32), sequence(objectId('60864801650304012a'), octet(iv.subarray(2)))),
    ),
    octet(Buffer.concat([cipher.update(value), cipher.final()])),
  )
}
function signature(value: Buffer): Buffer {
  const passKey = createHash('sha1').update(globalSalt).digest()
  const key = pbkdf2Sync(passKey, salt, 1, 32, 'sha256')
  const digest = createHmac('sha256', key)
    .update(Buffer.from('0000000000000011', 'hex'))
    .update(value)
    .digest()
  return sequence(
    sequence(
      objectId('2a864886f70d01050e'),
      sequence(kdfSpec(32), sequence(objectId('2a864886f70d0209'), der(5, Buffer.alloc(0)))),
    ),
    octet(digest),
  )
}
export function encryptedFirefox(value: string): string {
  const iv = Buffer.alloc(8, 0x18)
  const cipher = createCipheriv('des-ede3-cbc', loginKey, iv)
  return sequence(
    octet(keyId),
    sequence(objectId('2a864886f70d0307'), octet(iv)),
    octet(Buffer.concat([cipher.update(value), cipher.final()])),
  ).toString('base64')
}
export async function firefoxPasswords(input: ProtectedReadInput, master = ''): Promise<void> {
  const db = new DatabaseSync(join(input.profileDir, 'key4.db'))
  db.exec(
    'CREATE TABLE metadata(id TEXT PRIMARY KEY, item1 BLOB, item2 BLOB); CREATE TABLE nssPrivate(id INTEGER, a102 BLOB, a11 BLOB);',
  )
  db.prepare('INSERT INTO metadata VALUES(?,?,?)').run(
    'password',
    globalSalt,
    pbe(Buffer.from('password-check'), master),
  )
  db.prepare('INSERT INTO metadata VALUES(?,?,NULL)').run(
    'sig_key_00000001_00000011',
    signature(loginKey),
  )
  db.prepare('INSERT INTO nssPrivate VALUES(1,?,?)').run(keyId, pbe(loginKey, master))
  db.close()
  await writeFile(
    join(input.profileDir, 'logins.json'),
    JSON.stringify({
      logins: [
        {
          hostname: 'https://example.com',
          formSubmitURL: 'https://example.com/login',
          encryptedUsername: encryptedFirefox('fixture 用户'),
          encryptedPassword: encryptedFirefox('fixture 密码'),
          usernameField: 'email',
          passwordField: 'secret',
          timeCreated: 1700000000000,
          timeLastUsed: 1700000005000,
        },
      ],
    }),
  )
}
