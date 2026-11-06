import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { type BrowserCookie, createBrowserCookieState, restorableCookie } from '../cookie-state.mjs'

const session = (name = 'session'): BrowserCookie => ({
  name,
  value: '仅测试的会话凭据',
  domain: '.test.example',
  path: '/',
  secure: true,
  httpOnly: true,
  session: true,
  expires: -1,
  sameSite: 'None',
  priority: 'High',
})
function setup(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'litch-cookie-unit-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const key = randomBytes(32)
  const file = join(dir, 'browser', 'session-cookies.enc')
  let rows: BrowserCookie[] = []
  let changed = (_removed: boolean) => {}
  let available = true
  let read: (() => Promise<BrowserCookie[]>) | null = null
  const restored: Record<string, unknown>[] = []
  const warnings: string[] = []
  let flushes = 0
  const options = {
    file,
    cipher: {
      available: () => available,
      encrypt(plain: string) {
        const iv = randomBytes(12),
          cipher = createCipheriv('aes-256-gcm', key, iv)
        const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
      },
      decrypt(sealed: string) {
        const bytes = Buffer.from(sealed, 'base64')
        const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
        cipher.setAuthTag(bytes.subarray(12, 28))
        return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString()
      },
    },
    jar: {
      read: async () => (read ? read() : structuredClone(rows)),
      restore: async (cookie: Record<string, unknown>) => {
        restored.push(cookie)
      },
      flush: async () => {
        flushes++
      },
      changed(listener: (removed: boolean) => void) {
        changed = listener
        return () => {
          changed = () => {}
        }
      },
    },
    warn: () => warnings.push('保存或恢复失败'),
  }
  return {
    options,
    file,
    restored,
    warnings,
    change(removed = false) {
      changed(removed)
    },
    rows(value: BrowserCookie[]) {
      rows = value
    },
    lock() {
      available = false
    },
    read(value: typeof read) {
      read = value
    },
    flushes: () => flushes,
  }
}

test('加密保存会话 Cookie；重启恢复仍是会话 Cookie，不改长期 Cookie 到期时间', async (t) => {
  const f = setup(t)
  const state = await createBrowserCookieState(f.options)
  f.rows([session(), { ...session('persistent'), session: false, expires: 2_000_000_000 }])
  await state.flush()
  assert.equal(readFileSync(f.file, 'utf8').includes('仅测试的会话凭据'), false)
  assert.equal(readFileSync(f.file, 'utf8').includes('test.example'), false)
  state.dispose()
  f.rows([])
  const restarted = await createBrowserCookieState(f.options)
  assert.equal(f.restored.length, 1)
  assert.equal(f.restored[0]?.name, 'session')
  assert.equal(f.restored[0]?.expires, undefined)
  assert.equal(f.restored[0]?.secure, true)
  assert.equal(f.restored[0]?.httpOnly, true)
  assert.equal(f.restored[0]?.sameSite, 'None')
  restarted.dispose()
})

test('CHIPS 分区键与 host-only 身份不降级；不保存 opaque 分区', () => {
  const partitionKey = { topLevelSite: 'https://top.example', hasCrossSiteAncestor: true }
  const restored = restorableCookie({ ...session(), domain: 'host.example', partitionKey })
  assert.deepEqual(restored?.partitionKey, partitionKey)
  assert.equal(restored?.domain, undefined)
  assert.equal(restored?.url, 'https://host.example/')
  assert.equal(restorableCookie({ ...session(), partitionKeyOpaque: true }), null)
})

test('现有同身份 Cookie 不被旧会话覆盖，不同分区分别恢复', async (t) => {
  const f = setup(t)
  const state = await createBrowserCookieState(f.options)
  f.rows([
    session(),
    {
      ...session(),
      partitionKey: { topLevelSite: 'https://top.example', hasCrossSiteAncestor: false },
    },
  ])
  await state.flush()
  state.dispose()
  f.rows([{ ...session(), session: false }])
  const restarted = await createBrowserCookieState(f.options)
  assert.equal(f.restored.length, 1)
  assert.ok(f.restored[0]?.partitionKey)
  restarted.dispose()
})

test('注销立即作废旧密文，未等下一次保存也不会在重启时复活', async (t) => {
  const f = setup(t)
  const state = await createBrowserCookieState(f.options)
  f.rows([session()])
  await state.flush()
  f.rows([])
  f.change(true)
  assert.equal(existsSync(f.file), false)
  state.dispose()
  const restarted = await createBrowserCookieState(f.options)
  assert.deepEqual(f.restored, [])
  restarted.dispose()
})

test('清浏览数据与慢快照交错：旧读取不能把被清除的凭据写回来', async (t) => {
  const f = setup(t)
  const state = await createBrowserCookieState(f.options)
  f.rows([session()])
  await state.flush()
  let resolve: ((rows: BrowserCookie[]) => void) | undefined
  const promise = new Promise<BrowserCookie[]>((done) => {
    resolve = done
  })
  f.read(() => promise)
  const saving = state.flush()
  await Promise.resolve()
  const clearing = state.clear(async () => {
    f.rows([])
  })
  assert.ok(resolve)
  resolve([session()])
  await Promise.all([saving, clearing])
  assert.equal(existsSync(f.file), false)
  f.read(null)
  await state.flush()
  assert.equal(existsSync(f.file), false)
  assert.ok(f.flushes() >= 2)
  state.dispose()
})

test('加密不可用时不落明文，并废弃可能已失效的旧快照', async (t) => {
  const f = setup(t)
  const state = await createBrowserCookieState(f.options)
  f.rows([session()])
  await state.flush()
  f.lock()
  await state.flush()
  assert.equal(existsSync(f.file), false)
  assert.ok(f.warnings.length > 0)
  state.dispose()
})

test('注销与慢快照交错：删除前的读取不能重新保存已退出的登录', async (t) => {
  const f = setup(t)
  const state = await createBrowserCookieState(f.options)
  f.rows([session()])
  await state.flush()
  let resolve: ((rows: BrowserCookie[]) => void) | undefined
  const promise = new Promise<BrowserCookie[]>((done) => {
    resolve = done
  })
  f.read(() => promise)
  const saving = state.flush()
  await Promise.resolve()
  f.rows([])
  f.change(true)
  assert.ok(resolve)
  resolve([session()])
  await saving
  assert.equal(existsSync(f.file), false)
  state.dispose()
})

test('损坏的密文不会阻止启动；旧快照和临时密文都作废，错误不含凭据', async (t) => {
  const f = setup(t)
  const state = await createBrowserCookieState(f.options)
  f.rows([session()])
  await state.flush()
  state.dispose()
  writeFileSync(f.file, '损坏的测试凭据')
  writeFileSync(`${f.file}.tmp`, '损坏的临时密文')
  const restarted = await createBrowserCookieState(f.options)
  assert.equal(existsSync(f.file), false)
  assert.equal(existsSync(`${f.file}.tmp`), false)
  assert.deepEqual(f.restored, [])
  assert.deepEqual(f.warnings, ['保存或恢复失败'])
  restarted.dispose()
})

test('Cookie 变化自动保存并刷盘，读取失败后仍能再次保存', async (t) => {
  const f = setup(t)
  const state = await createBrowserCookieState(f.options)
  t.after(() => state.dispose())
  f.rows([session()])
  f.read(async () => {
    throw new Error('仅测试的会话凭据')
  })
  await state.flush()
  assert.equal(existsSync(f.file), false)
  assert.deepEqual(f.warnings, ['保存或恢复失败'])
  f.read(null)
  f.change()
  await t.waitFor(() => assert.equal(existsSync(f.file), true))
  assert.equal(f.flushes(), 1)
})
