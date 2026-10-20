// 密码库：加解密（假加密器换掉 safeStorage）、去重、无效的跳过、加密器不可用时拒绝存、列表不带密码、
// 按源取明文、读不懂的文件挪开（挪不开、读不了的不盖掉）、写失败不留临时文件。
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fillableOrigin, normalizeOrigin } from '../passwords/origin.mjs'
import {
  createPasswordStore,
  type PasswordCipher,
  PasswordEncryptionUnavailable,
  PasswordFileUnavailable,
  passwordsFile,
} from '../passwords/store.mjs'
import type { ImportedPassword } from '../passwords/types.mjs'

/** 和 safeStorage 一样的用法：真加密（AES-GCM，钥匙只在内存里），回 base64 */
function testCipher(on = true): PasswordCipher & { calls: number } {
  const key = randomBytes(32)
  const cipher = {
    calls: 0,
    available: () => on,
    encrypt(plain: string) {
      cipher.calls++
      const iv = randomBytes(12)
      const box = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([box.update(plain, 'utf8'), box.final()])
      return Buffer.concat([iv, box.getAuthTag(), body]).toString('base64')
    },
    decrypt(sealed: string) {
      const raw = Buffer.from(sealed, 'base64')
      const box = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
      box.setAuthTag(raw.subarray(12, 28))
      return Buffer.concat([box.update(raw.subarray(28)), box.final()]).toString('utf8')
    },
  }
  return cipher
}

const item = (over: Partial<ImportedPassword> = {}): ImportedPassword => ({
  origin: 'https://accounts.example.com',
  url: 'https://accounts.example.com/login?next=1',
  username: 'ann@example.com',
  password: 'correct horse battery',
  usernameField: 'email',
  passwordField: 'pass',
  created: 1_700_000_000,
  store: 'profile',
  ...over,
})

function setup(cipher: PasswordCipher = testCipher()) {
  const dir = mkdtempSync(join(tmpdir(), 'litch-passwords-'))
  const file = passwordsFile(dir)
  let clock = 1_800_000_000_000
  const store = createPasswordStore({ file, cipher, now: () => clock })
  return {
    dir,
    file,
    store,
    tick: (ms: number) => {
      clock += ms
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('导入的密码加密存盘，文件里没有明文，按源取得回来', async () => {
  const { file, store, done } = setup()
  try {
    const counts = await store.importMany([item()], 'chrome:Default')
    assert.deepEqual(counts, { imported: 1, skippedExisting: 0, skippedInvalid: 0, failed: 0 })
    const raw = readFileSync(file, 'utf8')
    assert.equal(raw.includes('correct horse battery'), false)
    assert.equal(raw.includes('ann@example.com'), true)
    const [saved] = store.list()
    assert.ok(saved)
    assert.deepEqual(Object.keys(saved).sort(), ['createdAt', 'id', 'origin', 'source', 'username'])
    assert.equal(saved.createdAt, 1_700_000_000_000)
    assert.equal(saved.source, 'chrome:Default')
    // 源要对得上
    assert.equal(store.reveal(saved.id, 'https://evil.example'), null)
    assert.deepEqual(store.reveal(saved.id, 'https://accounts.example.com'), {
      username: 'ann@example.com',
      password: 'correct horse battery',
    })
    assert.equal(typeof store.list()[0]?.lastUsedAt, 'number')
    // 另起一个库读同一个文件：存下来的东西都在
    const again = createPasswordStore({ file, cipher: testCipher() })
    assert.equal(again.list().length, 1)
  } finally {
    done()
  }
})

test('换了钥匙解不开：回 null，不抛', async () => {
  const { file, store, done } = setup()
  try {
    await store.importMany([item()], 'chrome:Default')
    const other = createPasswordStore({ file, cipher: testCipher() })
    const id = other.list()[0]?.id ?? ''
    assert.equal(other.reveal(id, 'https://accounts.example.com'), null)
  } finally {
    done()
  }
})

test('同源同用户名不覆盖：已有的、同一批里重复的都算已存在', async () => {
  const { store, done } = setup()
  try {
    await store.importMany([item()], 'chrome:Default')
    const counts = await store.importMany(
      [
        item({ password: 'another one' }),
        item({ origin: 'https://accounts.example.com/', username: 'bob' }),
        item({ username: 'bob', password: 'dup in batch' }),
        item({ origin: 'https://other.example.com' }),
      ],
      'firefox:default',
    )
    assert.deepEqual(counts, { imported: 2, skippedExisting: 2, skippedInvalid: 0, failed: 0 })
    const ann = store
      .list()
      .find((one) => one.username === 'ann@example.com' && one.origin.includes('accounts'))
    assert.equal(ann?.source, 'chrome:Default')
    assert.deepEqual(
      store.candidates('https://accounts.example.com').map((one) => one.username),
      ['ann@example.com', 'bob'],
    )
  } finally {
    done()
  }
})

test('非网页的、没密码的、太长的计入无效跳过；源能从登录页地址补出来', async () => {
  const { store, done } = setup()
  try {
    const counts = await store.importMany(
      [
        item({ origin: 'android://hash@com.example.app/', url: 'android://hash@com.example.app/' }),
        item({ origin: 'ftp://files.example.com' }),
        item({ password: '' }),
        item({ username: 'x'.repeat(2000) }),
        item({ origin: '', url: 'https://from-url.example.com/sign-in' }),
        item({ origin: 'https://user:pw@bad.example.com' }),
      ],
      'chrome:Default',
    )
    assert.deepEqual(counts, { imported: 1, skippedExisting: 0, skippedInvalid: 5, failed: 0 })
    assert.equal(store.list()[0]?.origin, 'https://from-url.example.com')
  } finally {
    done()
  }
})

test('加密器不可用：拒绝存，什么都不写', async () => {
  const { file, store, done } = setup(testCipher(false))
  try {
    await assert.rejects(
      store.importMany([item()], 'chrome:Default'),
      (error: unknown) =>
        error instanceof PasswordEncryptionUnavailable &&
        error.code === 'encryption-unavailable' &&
        !error.message.includes('correct horse'),
    )
    assert.equal(existsSync(file), false)
    // 空的一批不用加密器
    assert.deepEqual(await store.importMany([], 'x'), {
      imported: 0,
      skippedExisting: 0,
      skippedInvalid: 0,
      failed: 0,
    })
  } finally {
    done()
  }
})

test('单条加密失败计入失败，其余照存', async () => {
  const base = testCipher()
  const cipher: PasswordCipher = {
    available: () => true,
    encrypt: (plain) => {
      if (plain === 'boom') throw new Error('no')
      return base.encrypt(plain)
    },
    decrypt: (sealed) => base.decrypt(sealed),
  }
  const { store, done } = setup(cipher)
  try {
    const counts = await store.importMany(
      [item({ password: 'boom' }), item({ username: 'bob' })],
      'chrome:Default',
    )
    assert.deepEqual(counts, { imported: 1, skippedExisting: 0, skippedInvalid: 0, failed: 1 })
  } finally {
    done()
  }
})

test('删一条、全删，变了会通知', async () => {
  const { store, done } = setup()
  try {
    let changes = 0
    const off = store.onChange(() => changes++)
    await store.importMany([item(), item({ username: 'bob' })], 'chrome:Default')
    const id = store.list()[0]?.id ?? ''
    assert.equal(store.remove('nope'), false)
    assert.equal(store.remove(id), true)
    assert.equal(store.list().length, 1)
    assert.equal(store.removeAll(), 1)
    assert.equal(store.list().length, 0)
    assert.equal(changes, 3)
    off()
  } finally {
    done()
  }
})

test('读不懂的文件挪到一边，不在上面接着写', async () => {
  const { dir, file, done } = setup()
  try {
    const store = createPasswordStore({ file, cipher: testCipher() })
    mkdirSync(join(dir, 'browser'))
    writeFileSync(file, '{oops')
    assert.deepEqual(store.list(), [])
    await store.importMany([item()], 'chrome:Default')
    const names = readdirSync(join(dir, 'browser'))
    assert.ok(names.some((name) => name.startsWith('passwords.json.broken-')))
    assert.equal(store.list().length, 1)
  } finally {
    done()
  }
})

test('读不了（权限）不当损坏：不挪、不写，抛给人看的错误，能读了再接着用', async () => {
  const { dir, file, done } = setup()
  try {
    const store = createPasswordStore({ file, cipher: testCipher() })
    mkdirSync(join(dir, 'browser'))
    writeFileSync(file, '{"version":1,"entries":[]}\n')
    chmodSync(file, 0o000)
    assert.throws(() => store.list(), PasswordFileUnavailable)
    await assert.rejects(store.importMany([item()], 'chrome:Default'), PasswordFileUnavailable)
    // 只读的地方当没有，不抛
    assert.deepEqual(store.candidates('https://accounts.example.com'), [])
    assert.equal(store.isNever('https://accounts.example.com'), false)
    assert.deepEqual(readdirSync(join(dir, 'browser')), ['passwords.json'])
    chmodSync(file, 0o600)
    assert.deepEqual(store.list(), [])
    await store.importMany([item()], 'chrome:Default')
    assert.equal(store.list().length, 1)
  } finally {
    chmodSync(join(dir, 'browser'), 0o700)
    done()
  }
})

test('读不懂又挪不开：不把它当空的盖掉，下次再试', async () => {
  const { dir, file, done } = setup()
  const folder = join(dir, 'browser')
  try {
    const store = createPasswordStore({ file, cipher: testCipher() })
    mkdirSync(folder)
    writeFileSync(file, '{oops')
    chmodSync(folder, 0o500)
    assert.throws(() => store.list(), PasswordFileUnavailable)
    await assert.rejects(store.importMany([item()], 'chrome:Default'), PasswordFileUnavailable)
    assert.equal(readFileSync(file, 'utf8'), '{oops')
    chmodSync(folder, 0o700)
    assert.deepEqual(store.list(), [])
    assert.ok(readdirSync(folder).some((name) => name.startsWith('passwords.json.broken-')))
  } finally {
    chmodSync(folder, 0o700)
    done()
  }
})

test('写文件失败：不留临时文件，库里还是原来的', async () => {
  const { dir, file, store, done } = setup()
  const folder = join(dir, 'browser')
  try {
    await store.importMany([item()], 'chrome:Default')
    chmodSync(folder, 0o500)
    const counts = await store.importMany([item({ username: 'bob' })], 'chrome:Default')
    assert.equal(counts.failed, 1)
    assert.throws(() => store.removeAll())
    assert.equal(store.list().length, 1)
    chmodSync(folder, 0o700)
    assert.deepEqual(readdirSync(folder), ['passwords.json'])
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).entries.length, 1)
  } finally {
    chmodSync(folder, 0o700)
    done()
  }
})

test('源的规范化与能不能填', () => {
  assert.equal(normalizeOrigin('https://Example.com:443/a?b'), 'https://example.com')
  assert.equal(normalizeOrigin('http://example.com:8080/'), 'http://example.com:8080')
  assert.equal(normalizeOrigin('android://x@com.app/'), null)
  assert.equal(normalizeOrigin('not a url'), null)
  assert.equal(fillableOrigin('https://example.com'), 'https://example.com')
  assert.equal(fillableOrigin('http://example.com'), null)
  assert.equal(fillableOrigin('http://localhost:5173'), 'http://localhost:5173')
  assert.equal(fillableOrigin('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')
  assert.equal(fillableOrigin('http://[::1]:8080'), 'http://[::1]:8080')
  assert.equal(fillableOrigin('http://app.localhost'), 'http://app.localhost')
  assert.equal(fillableOrigin('http://localhost.example.com'), null)
  assert.equal(fillableOrigin('null'), null)
  assert.equal(fillableOrigin(''), null)
  assert.equal(fillableOrigin('file://'), null)
})
