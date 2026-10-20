import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseDer } from '../der.mjs'
import { readerForPlatform } from '../reader.mjs'
import { faultStatus } from '../result.mjs'
import {
  chromeCookies,
  encryptedMac,
  firefoxCookies,
  firefoxPasswords,
  fixture,
  secrets,
} from './fixtures.mjs'

test('明文 Cookie 不弹授权，旧版本密文不剥域名摘要，持久零到期值不变成会话', async () => {
  const f = await fixture()
  try {
    const db = chromeCookies(f.input, 23)
    db.prepare(
      'INSERT INTO cookies(host_key,name,value,encrypted_value,has_expires,is_persistent) VALUES(?,?,?,?,1,1)',
    ).run('example.com', 'plain', 'plain fixture', Buffer.alloc(0))
    db.prepare('INSERT INTO cookies(host_key,name,value,encrypted_value) VALUES(?,?,?,?)').run(
      'example.com',
      'v23',
      '',
      encryptedMac('no hash prefix'),
    )
    db.close()
    const result = await readerForPlatform('darwin', secrets).read(f.input)
    assert.equal(result.cookies?.status, 'ok')
    assert.equal(result.cookies?.items[0]?.expires, -11_644_473_600)
    assert.equal(result.cookies?.items[1]?.value, 'no hash prefix')
  } finally {
    await f.dispose()
  }
})

test('Firefox 容器不混入普通会话，筛选在隔离区处理之前执行', async () => {
  const f = await fixture('firefox')
  try {
    const db = firefoxCookies(f.input)
    db.prepare('INSERT INTO moz_cookies(host,name,value,originAttributes) VALUES(?,?,?,?)').run(
      'example.com',
      'normal',
      'normal fixture',
      '',
    )
    db.prepare('INSERT INTO moz_cookies(host,name,value,originAttributes) VALUES(?,?,?,?)').run(
      'container.example',
      'container',
      'container fixture',
      '^userContextId=1',
    )
    db.close()
    const reader = readerForPlatform('darwin')
    const result = await reader.read(f.input)
    assert.equal(result.cookies?.status, 'partial')
    assert.equal(result.cookies?.failed, 1)
    assert.equal(result.cookies?.items.length, 1)
    const filtered = await reader.read({ ...f.input, cookieDomains: ['example.com'] })
    assert.equal(filtered.cookies?.status, 'ok')
    assert.equal(filtered.cookies?.failed, 0)
    assert.equal(filtered.cookies?.discovered, 2)
  } finally {
    await f.dispose()
  }
})

test('Firefox 单条损坏不影响其他密码，缺 key4 不被误报为没有密码', async () => {
  const f = await fixture('firefox')
  try {
    await firefoxPasswords(f.input)
    const path = join(f.input.profileDir, 'logins.json')
    const data = JSON.parse(await readFile(path, 'utf8')) as { logins: unknown[] }
    data.logins.push({ encryptedUsername: 'broken', encryptedPassword: 'broken' })
    await writeFile(path, JSON.stringify(data))
    const result = await readerForPlatform('darwin').read(f.input)
    assert.equal(result.passwords?.status, 'partial')
    assert.equal(result.passwords?.discovered, 2)
    assert.equal(result.passwords?.failed, 1)
    assert.equal(result.passwords?.items.length, 1)
  } finally {
    await f.dispose()
  }
  const missing = await fixture('firefox')
  try {
    await writeFile(join(missing.input.profileDir, 'logins.json'), JSON.stringify({ logins: [{}] }))
    const result = await readerForPlatform('darwin').read(missing.input)
    assert.equal(result.passwords?.status, 'unsupported')
    assert.equal(result.passwords?.failed, 1)
  } finally {
    await missing.dispose()
  }
})

test('NSS DER 越界、不定长及过深结构被拒绝', () => {
  for (const input of ['30800000', '30050401', '04016100', '3084ffffffff']) {
    assert.throws(() => parseDer(Buffer.from(input, 'hex')))
  }
  let nested = Buffer.from('0400', 'hex')
  for (let i = 0; i < 20; i++) nested = Buffer.concat([Buffer.from([0x30, nested.length]), nested])
  assert.throws(() => parseDer(nested))
  assert.equal(faultStatus({ code: 'ERR_SQLITE_ERROR', errcode: 5 }), 'locked')
  assert.equal(faultStatus({ code: 'ERR_SQLITE_ERROR', errcode: 776 }), 'locked')
})
