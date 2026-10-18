// 应用自己的更新清单（litch-update.json）：读清单、比版本、挑这一端要装的那一项。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareVersions, parseUpdateFeed, updateFor } from '../src/index.mjs'

const SHA = 'a'.repeat(64)
const asset = (name: string, extra: Record<string, unknown> = {}) => ({
  url: `https://github.com/slovx2/litch/releases/download/v0.9.0/${name}`,
  sha256: SHA,
  size: 1024,
  ...extra,
})
const feed = (overrides: Record<string, unknown> = {}) => ({
  version: '0.9.0',
  pubDate: '2026-10-18T08:00:00Z',
  notesUrl: 'https://github.com/slovx2/litch/releases/tag/v0.9.0',
  assets: {
    'macos-arm64': asset('Litch-0.9.0-macos-arm64.zip'),
    'windows-x64': asset('Litch-0.9.0-windows-x64-setup.exe'),
    'android-arm64': asset('Litch-0.9.0-android-arm64.apk', { versionCode: 9000 }),
  },
  currentRelease: '0.9.0',
  releases: [],
  ...overrides,
})

test('比版本：数字逐段、预发布比正式版旧、构建信息不比', () => {
  assert.equal(compareVersions('0.9.0', '0.8.1'), 1)
  assert.equal(compareVersions('0.8.1', '0.9.0'), -1)
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc'), 1)
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1)
  assert.equal(compareVersions('1.0.0+abc', '1.0.0+def'), 0)
  assert.equal(compareVersions('1.0', '1.0.0'), null)
  assert.equal(compareVersions('0.0.0-unknown', '0.0.1'), -1)
})

test('读清单：只留认得的三个端，额外的键不管', () => {
  const parsed = parseUpdateFeed(feed())
  assert.equal(parsed.version, '0.9.0')
  assert.deepEqual(Object.keys(parsed.assets).sort(), [
    'android-arm64',
    'macos-arm64',
    'windows-x64',
  ])
  assert.equal(parsed.assets['android-arm64']?.versionCode, 9000)
  const onlyMac = parseUpdateFeed(
    feed({ assets: { 'macos-arm64': asset('a.zip'), 'linux-x64': asset('b.tar.gz') } }),
  )
  assert.deepEqual(Object.keys(onlyMac.assets), ['macos-arm64'])
})

test('读清单：形状不对就报错，不猜', () => {
  assert.throws(() => parseUpdateFeed(null), /不是一个对象/)
  assert.throws(() => parseUpdateFeed(feed({ version: 'latest' })), /版本号/)
  assert.throws(() => parseUpdateFeed(feed({ assets: undefined })), /assets/)
  const bad = (patch: Record<string, unknown>) =>
    feed({ assets: { 'windows-x64': { ...asset('x.exe'), ...patch } } })
  assert.throws(() => parseUpdateFeed(bad({ url: 'http://example.com/x.exe' })), /地址/)
  assert.throws(() => parseUpdateFeed(bad({ url: 'ftp://example.com/x.exe' })), /地址/)
  assert.throws(() => parseUpdateFeed(bad({ sha256: 'ABC' })), /校验和/)
  assert.throws(() => parseUpdateFeed(bad({ size: 0 })), /大小/)
  assert.throws(() => parseUpdateFeed(bad({ versionCode: '9000' })), /versionCode/)
})

test('读清单：开发时允许 http 的假服务', () => {
  const local = feed({
    assets: { 'android-arm64': { ...asset('x.apk'), url: 'http://127.0.0.1:8766/x.apk' } },
  })
  assert.throws(() => parseUpdateFeed(local), /地址/)
  assert.equal(
    parseUpdateFeed(local, { allowHttp: true }).assets['android-arm64']?.url,
    'http://127.0.0.1:8766/x.apk',
  )
})

test('这一端该不该更新：比眼前新、而且给这一端出了包', () => {
  const parsed = parseUpdateFeed(feed())
  assert.equal(updateFor(parsed, '0.8.1', 'windows-x64')?.version, '0.9.0')
  assert.equal(updateFor(parsed, '0.9.0', 'windows-x64'), null)
  assert.equal(updateFor(parsed, '0.10.0', 'windows-x64'), null)
  assert.equal(updateFor(parsed, '0.9.0-rc.1', 'android-arm64')?.version, '0.9.0')
  assert.equal(updateFor(parsed, 'dev', 'macos-arm64'), null)
  const noAndroid = parseUpdateFeed(feed({ assets: { 'macos-arm64': asset('a.zip') } }))
  assert.equal(updateFor(noAndroid, '0.8.1', 'android-arm64'), null)
})
