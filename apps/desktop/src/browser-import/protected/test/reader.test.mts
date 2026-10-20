import assert from 'node:assert/strict'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createProtectedReader } from '../index.mjs'
import { readerForPlatform } from '../reader.mjs'
import { ReadFault } from '../result.mjs'
import type { BrowserId } from '../types.mjs'
import {
  addCookie,
  chromeCookies,
  chromePasswords,
  chromeTime,
  domainValue,
  encryptedMac,
  encryptedWin,
  firefoxCookies,
  firefoxPasswords,
  fixture,
  localState,
  secrets,
} from './fixtures.mjs'

test('七个来源两平台的能力，以及不支持的平台', async () => {
  for (const platform of ['darwin', 'win32'] as const) {
    for (const browser of [
      'chrome',
      'edge',
      'brave',
      'arc',
      'chromium',
      'vivaldi',
      'firefox',
    ] as BrowserId[]) {
      const caps = readerForPlatform(platform).capabilities(browser)
      assert.deepEqual(caps.kinds, ['cookies', 'passwords'])
      assert.equal(caps.promptsSystemAuth, platform === 'darwin' && browser !== 'firefox')
      assert.equal(caps.needsElevation, platform === 'win32' && browser !== 'firefox')
    }
  }
  assert.deepEqual(readerForPlatform('linux').capabilities('chrome').kinds, [])
  assert.deepEqual(
    createProtectedReader().capabilities('firefox'),
    readerForPlatform(process.platform).capabilities('firefox'),
  )
  const f = await fixture()
  try {
    const result = await readerForPlatform('linux').read(f.input)
    assert.equal(result.cookies?.status, 'unsupported')
    assert.equal(result.passwords?.status, 'unsupported')
  } finally {
    await f.dispose()
  }
})

test('Mac Cookie v24：验证域名摘要，保留过期、会话、分区、时间和原主机键', async () => {
  const f = await fixture()
  try {
    const db = chromeCookies(f.input)
    addCookie(db)
    addCookie(db, 'old.example.com', 'expired fixture')
    db.prepare(
      'UPDATE cookies SET expires_utc=?,has_expires=1,is_persistent=1,creation_utc=?,last_access_utc=?,top_frame_site_key=? WHERE host_key=?',
    ).run(chromeTime(100), chromeTime(50), chromeTime(60), 'https://top.example', 'old.example.com')
    db.close()
    const before = await readFile(join(f.input.profileDir, 'Cookies'))
    const result = await readerForPlatform('darwin', secrets).read({
      ...f.input,
      kinds: ['cookies'],
    })
    assert.deepEqual(Object.keys(result), ['cookies'])
    assert.equal(result.cookies?.status, 'ok')
    assert.equal(result.cookies?.discovered, 2)
    assert.equal(result.cookies?.failed, 0)
    assert.deepEqual(result.cookies?.items[0], {
      host: '.example.com',
      name: 'sid',
      value: 'cookie fixture',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    })
    assert.equal(result.cookies?.items[1]?.expires, 100)
    assert.equal(result.cookies?.items[1]?.created, 50)
    assert.equal(result.cookies?.items[1]?.lastAccessed, 60)
    assert.equal(result.cookies?.items[1]?.partitionTopSite, 'https://top.example')
    assert.deepEqual(await readFile(join(f.input.profileDir, 'Cookies')), before)
  } finally {
    await f.dispose()
  }
})

test('域名过滤含子域，不误匹配后缀；未匹配的密文不触发授权', async () => {
  const f = await fixture()
  try {
    const db = chromeCookies(f.input)
    for (const host of ['.example.com', 'sub.example.com', 'notexample.com', 'example.com.evil'])
      addCookie(db, host)
    db.close()
    let calls = 0
    const reader = readerForPlatform('darwin', {
      ...secrets,
      async keychain(browser, signal) {
        calls++
        return secrets.keychain(browser, signal)
      },
    })
    const none = await reader.read({
      ...f.input,
      kinds: ['cookies'],
      cookieDomains: ['absent.example'],
    })
    assert.equal(calls, 0)
    assert.equal(none.cookies?.discovered, 4)
    assert.deepEqual(none.cookies?.items, [])
    const some = await reader.read({
      ...f.input,
      kinds: ['cookies'],
      cookieDomains: ['example.com'],
    })
    assert.deepEqual(
      some.cookies?.items.map((item) => item.host),
      ['.example.com', 'sub.example.com'],
    )
    assert.equal(calls, 1)
  } finally {
    await f.dispose()
  }
})

test('坏记录只计该条失败：域名摘要错误、密文损坏、未知版本', async () => {
  const f = await fixture()
  try {
    const db = chromeCookies(f.input)
    addCookie(db)
    const insert = db.prepare(
      'INSERT INTO cookies(host_key,name,value,encrypted_value) VALUES(?,?,?,?)',
    )
    insert.run(
      'other.example',
      'bad-hash',
      '',
      encryptedMac(domainValue('wrong.example', 'secret')),
    )
    insert.run('other.example', 'broken', '', Buffer.from('v10broken'))
    insert.run('other.example', 'future', '', Buffer.from('v99unknown'))
    db.close()
    const result = await readerForPlatform('darwin', secrets).read(f.input)
    assert.equal(result.cookies?.status, 'partial')
    assert.equal(result.cookies?.discovered, 4)
    assert.equal(result.cookies?.failed, 3)
    assert.equal(result.cookies?.items.length, 1)
    assert.equal(result.passwords?.status, 'missing')
  } finally {
    await f.dispose()
  }
})

test('本地及账号密码库分别返回，系统密钥仅读一次且不跨调用缓存', async () => {
  const f = await fixture()
  try {
    for (const account of [false, true]) {
      const db = chromePasswords(f.input, account)
      db.prepare(
        'INSERT INTO logins(origin_url,action_url,username_value,password_value) VALUES(?,?,?,?)',
      ).run(
        'https://accounts.example.com/login',
        'https://submit.example.com/form',
        'fixture user',
        encryptedMac('fixture password'),
      )
      db.close()
    }
    let calls = 0
    let buffer: Buffer | undefined
    const reader = readerForPlatform('darwin', {
      ...secrets,
      async keychain(browser, signal) {
        calls++
        buffer = await secrets.keychain(browser, signal)
        return buffer
      },
    })
    for (let i = 0; i < 2; i++) {
      const result = await reader.read({ ...f.input, kinds: ['passwords'] })
      assert.equal(result.passwords?.status, 'ok')
      assert.equal(result.passwords?.discovered, 2)
      assert.deepEqual(
        result.passwords?.items.map((item) => item.store),
        ['profile', 'account'],
      )
      assert.equal(result.passwords?.items[0]?.origin, 'https://accounts.example.com')
      assert.equal(result.passwords?.items[0]?.actionOrigin, 'https://submit.example.com')
      assert.equal(result.passwords?.items[0]?.password, 'fixture password')
      assert.ok(buffer?.every((byte) => byte === 0))
    }
    assert.equal(calls, 2)
  } finally {
    await f.dispose()
  }
})

test('一个密码库坏了，另一库仍可读', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.input.profileDir, 'Login Data'), 'not a sqlite database')
    const db = chromePasswords(f.input, true)
    db.prepare('INSERT INTO logins(origin_url,password_value) VALUES(?,?)').run(
      'https://example.com',
      encryptedMac('fixture'),
    )
    db.close()
    const result = await readerForPlatform('darwin', secrets).read(f.input)
    assert.equal(result.passwords?.status, 'partial')
    assert.equal(result.passwords?.items[0]?.store, 'account')
  } finally {
    await f.dispose()
  }
})

test('Windows v10 GCM 与 DPAPI 旧记录；损坏认证标签不返回明文', async () => {
  const f = await fixture()
  try {
    await localState(f.input)
    const db = chromeCookies(f.input)
    addCookie(db, '.example.com', 'Windows fixture', encryptedWin)
    const broken = encryptedWin(domainValue('.example.com', 'bad tag'))
    broken[broken.length - 1] = (broken[broken.length - 1] ?? 0) ^ 1
    db.prepare('INSERT INTO cookies(host_key,encrypted_value) VALUES(?,?)').run(
      '.example.com',
      broken,
    )
    db.close()
    const pw = chromePasswords(f.input)
    pw.prepare('INSERT INTO logins(origin_url,password_value) VALUES(?,?)').run(
      'https://example.com',
      Buffer.from('old dpapi blob'),
    )
    pw.close()
    const result = await readerForPlatform('win32', {
      ...secrets,
      async unprotect(data, signal) {
        return data.toString() === 'old dpapi blob'
          ? Buffer.from('DPAPI fixture')
          : secrets.unprotect(data, signal)
      },
    }).read(f.input)
    assert.equal(result.cookies?.status, 'partial')
    assert.equal(result.cookies?.failed, 1)
    assert.equal(result.cookies?.items[0]?.value, 'Windows fixture')
    assert.equal(result.passwords?.items[0]?.password, 'DPAPI fixture')
  } finally {
    await f.dispose()
  }
})

test('应用绑定记录不会私自提权：没有同意报 needs-elevation，有同意仍诚实报 unsupported', async () => {
  const f = await fixture()
  try {
    const db = chromeCookies(f.input)
    db.prepare('INSERT INTO cookies(host_key,encrypted_value) VALUES(?,?)').run(
      'example.com',
      Buffer.from('v20fixture'),
    )
    db.close()
    const noSecrets = {
      async keychain(): Promise<Buffer> {
        assert.fail('不应读取密钥')
      },
      async unprotect(): Promise<Buffer> {
        assert.fail('不应尝试解密')
      },
    }
    const reader = readerForPlatform('win32', noSecrets)
    assert.equal((await reader.read(f.input)).cookies?.status, 'needs-elevation')
    assert.equal(
      (await reader.read({ ...f.input, allowElevated: true })).cookies?.status,
      'unsupported',
    )
  } finally {
    await f.dispose()
  }
})

test('授权拒绝、系统异常均脱敏，拒绝不重复弹框', async () => {
  const f = await fixture()
  try {
    const db = chromeCookies(f.input)
    addCookie(db)
    addCookie(db)
    db.close()
    let calls = 0
    const denied = readerForPlatform('darwin', {
      ...secrets,
      async keychain() {
        calls++
        throw new ReadFault('denied')
      },
    })
    const result = await denied.read(f.input)
    assert.equal(result.cookies?.status, 'denied')
    assert.equal(result.cookies?.failed, 2)
    assert.equal(calls, 1)
    const bad = await readerForPlatform('darwin', {
      ...secrets,
      async keychain() {
        throw new Error('SECRET_VALUE_MUST_NOT_LEAK')
      },
    }).read(f.input)
    assert.equal(bad.cookies?.status, 'failed')
    assert.ok(!JSON.stringify(bad).includes('SECRET_VALUE'))
  } finally {
    await f.dispose()
  }
})

test('取消丢弃结果、清理快照；预取消不弹授权', async () => {
  const f = await fixture()
  try {
    const before = (await readdir(tmpdir()))
      .filter((name) => name.startsWith('litch-browser-import-'))
      .sort()
    const db = chromeCookies(f.input)
    addCookie(db)
    db.close()
    const controller = new AbortController()
    const reader = readerForPlatform('darwin', {
      ...secrets,
      async keychain(browser, signal) {
        controller.abort()
        return secrets.keychain(browser, signal)
      },
    })
    const result = await reader.read({ ...f.input, signal: controller.signal })
    assert.equal(result.cookies?.status, 'cancelled')
    assert.deepEqual(result.cookies?.items, [])
    assert.equal(result.passwords?.status, 'cancelled')
    const after = (await readdir(tmpdir()))
      .filter((name) => name.startsWith('litch-browser-import-'))
      .sort()
    assert.deepEqual(after, before)
    assert.equal(
      (await reader.read({ ...f.input, signal: controller.signal })).cookies?.status,
      'cancelled',
    )
  } finally {
    await f.dispose()
  }
})

test('Firefox Cookie、PBES2 密钥和 3DES 登录记录，两个平台均能读', async () => {
  const f = await fixture('firefox')
  try {
    const db = firefoxCookies(f.input)
    db.prepare('INSERT INTO moz_cookies(host,name,value,originAttributes) VALUES(?,?,?,?)').run(
      '.example.com',
      'sid',
      'firefox fixture',
      '^partitionKey=%28https%2Ctop.example%29',
    )
    db.close()
    await firefoxPasswords(f.input)
    for (const platform of ['darwin', 'win32'] as const) {
      const result = await readerForPlatform(platform, secrets).read(f.input)
      assert.equal(result.cookies?.status, 'ok')
      assert.equal(result.cookies?.items[0]?.partitionTopSite, 'https://top.example')
      assert.equal(result.cookies?.items[0]?.expires, 1700000000)
      assert.equal(result.passwords?.status, 'ok')
      assert.equal(result.passwords?.items[0]?.username, 'fixture 用户')
      assert.equal(result.passwords?.items[0]?.password, 'fixture 密码')
      assert.equal(result.passwords?.items[0]?.lastUsed, 1700000005)
    }
  } finally {
    await f.dispose()
  }
})

test('Firefox 主密码不猜测；损坏的 NSS 密钥签名不得忽略', async () => {
  for (const master of ['', 'sample primary password']) {
    const f = await fixture('firefox')
    try {
      await firefoxPasswords(f.input, master)
      if (!master) {
        const db = new DatabaseSync(join(f.input.profileDir, 'key4.db'))
        db.prepare("UPDATE metadata SET item1=? WHERE id LIKE 'sig_%'").run(
          Buffer.from('corrupted signature'),
        )
        db.close()
      }
      const result = await readerForPlatform('darwin', secrets).read(f.input)
      assert.equal(result.passwords?.status, master ? 'unsupported' : 'failed')
      assert.equal(result.passwords?.failed, 1)
      assert.deepEqual(result.passwords?.items, [])
    } finally {
      await f.dispose()
    }
  }
})
