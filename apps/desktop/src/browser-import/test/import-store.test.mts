// 正式接线：管线照 install.mts 那样组装（assembleImporter），密码交给内置浏览器真的密码库（browser/passwords/store.mts，
// 只是加密器换成假的），不走样本模式的内存假库。看密码那一类列得出来、导得进库、再导一次算已存在、明文不落盘。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createPasswordStore,
  type PasswordCipher,
  passwordsFile,
} from '../../browser/passwords/store.mjs'
import { assembleImporter } from '../assemble.mjs'
import type { CookieJar } from '../cookies.mjs'
import { createFakeReader } from './fake-reader.mjs'
import { writeSample } from './sample.mjs'

const NOW = Date.UTC(2026, 9, 22, 12)

/** 假加密器：可逆就行，带个前缀好认出“加过密” */
const cipher: PasswordCipher = {
  available: () => true,
  encrypt: (plain) => `sealed:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (sealed) => Buffer.from(sealed.slice('sealed:'.length), 'base64').toString('utf8'),
}

/** 这条用例只导密码，Cookie 罐用不上 */
const noCookies: CookieJar = {
  list: async () => [],
  set: async () => {},
  flush: async () => {},
}

test('正式接线：Chrome 的密码列得出来、导进内置浏览器的密码库，再导一次算已存在', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-import-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const env = writeSample(join(dir, 'home'), 'darwin', NOW)
  const userData = join(dir, 'userData')
  const store = createPasswordStore({ file: passwordsFile(userData), cipher, now: () => NOW })
  const importer = assembleImporter({
    env: () => env,
    reader: createFakeReader(),
    cookies: noCookies,
    passwords: store,
    userData,
    now: () => NOW,
  })

  const chrome = importer.sources().find((source) => source.browser === 'chrome')
  assert.deepEqual(chrome?.kinds, ['cookies', 'passwords'])

  const request = {
    browser: 'chrome' as const,
    profileId: 'Default',
    kinds: ['passwords' as const],
    allowElevated: false,
  }
  const first = await importer.start(request)
  assert.equal(first.kinds.passwords?.status, 'ok')
  assert.equal(first.kinds.passwords?.imported, 2)
  assert.deepEqual(
    store.list().map((item) => [item.origin, item.username, item.source]),
    [
      ['https://accounts.example.com', 'sample-user', 'chrome:Default'],
      ['https://shop.example.org', 'buyer', 'chrome:Default'],
    ],
  )
  const second = await importer.start(request)
  assert.equal(second.kinds.passwords?.imported, 0)
  assert.equal(second.kinds.passwords?.skippedExisting, 2)
  // 落盘的是加过密的
  const onDisk = readFileSync(passwordsFile(userData), 'utf8')
  assert.ok(onDisk.includes('sealed:'))
  for (const item of store.list()) {
    const plain = store.reveal(item.id, item.origin)?.password ?? ''
    assert.ok(plain !== '' && !onDisk.includes(plain))
  }
})
