// 设置页“内置浏览器”“Computer Use”两节和设备详情里那一句提示的判断（src/settings/tools-logic.ts）：
// 每项权限显示成什么、什么时候给“重启助手”、设备详情里说不说、清单的几种样子和排序。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const {
  allGranted,
  dayOf,
  deviceHint,
  helperLook,
  listPhase,
  offersRestart,
  PANES,
  permissionLook,
  siteLabel,
  sortApps,
  sortSites,
  winWarnings,
} = await import('../src/settings/tools-logic.ts')

const ready = (accessibility, screenRecording) => ({
  helper: 'ready',
  permissions: { accessibility, screenRecording },
})

test('两项权限按顺序，各自是给了、没给、不知道', () => {
  assert.deepEqual(PANES, ['accessibility', 'screenRecording'])
  const half = ready(true, false)
  assert.equal(permissionLook(half, 'accessibility'), 'granted')
  assert.equal(permissionLook(half, 'screenRecording'), 'missing')
  // 还没问到、助手起不来、没在跑也没问过
  assert.equal(permissionLook(null, 'accessibility'), 'unknown')
  assert.equal(
    permissionLook({ helper: 'failed', permissions: null, reason: 'x' }, 'screenRecording'),
    'unknown',
  )
  assert.equal(permissionLook({ helper: 'idle', permissions: null }, 'accessibility'), 'unknown')
  // 没在跑但上一次问过：照上一次的
  assert.equal(
    permissionLook(
      { helper: 'idle', permissions: { accessibility: false, screenRecording: true } },
      'screenRecording',
    ),
    'granted',
  )
})

test('“重启助手”只在助手在跑而屏幕录制还没给的时候出', () => {
  assert.equal(offersRestart(ready(true, false)), true)
  assert.equal(offersRestart(ready(false, false)), true)
  assert.equal(offersRestart(ready(false, true)), false)
  assert.equal(offersRestart(ready(true, true)), false)
  assert.equal(
    offersRestart({ helper: 'idle', permissions: { accessibility: true, screenRecording: false } }),
    false,
  )
  assert.equal(offersRestart({ helper: 'failed', permissions: null }), false)
  assert.equal(offersRestart(null), false)
  assert.equal(allGranted(ready(true, true)), true)
  assert.equal(allGranted(ready(true, false)), false)
  assert.equal(allGranted(null), false)
})

test('设备详情里那一句：知道没给全才说“用不了”，没问过淡淡提一句，都给了不说', () => {
  assert.equal(deviceHint(ready(true, false)), 'missing')
  assert.equal(deviceHint(ready(false, true)), 'missing')
  assert.equal(deviceHint(ready(true, true)), null)
  assert.equal(deviceHint({ helper: 'idle', permissions: null }), 'unknown')
  assert.equal(
    deviceHint({ helper: 'idle', permissions: { accessibility: true, screenRecording: true } }),
    null,
  )
  assert.equal(deviceHint(null), 'unknown')
  assert.equal(deviceHint(undefined), 'unknown')
})

test('清单的几种样子', () => {
  assert.equal(listPhase(null, false), 'loading')
  assert.equal(listPhase(undefined, false), 'loading')
  assert.equal(listPhase(null, true), 'failed')
  assert.equal(listPhase([], false), 'empty')
  assert.equal(listPhase([1], false), 'list')
})

test('网站最近允许的在前，应用按名字排；https 的来源只写主机', () => {
  const sites = sortSites([
    { origin: 'https://b.example', at: 10 },
    { origin: 'https://a.example', at: 10 },
    { origin: 'http://old.example', at: 1 },
    { origin: 'https://new.example:8443', at: 99 },
  ])
  assert.deepEqual(
    sites.map((site) => site.origin),
    ['https://new.example:8443', 'https://a.example', 'https://b.example', 'http://old.example'],
  )
  assert.equal(siteLabel('https://new.example:8443'), 'new.example:8443')
  assert.equal(siteLabel('http://old.example'), 'http://old.example')

  const apps = sortApps([
    { bundleId: 'com.b', name: 'Notes', addedAt: '' },
    { bundleId: 'com.a', name: 'Notes', addedAt: '' },
    { bundleId: 'com.c', name: 'Maps', addedAt: '' },
  ])
  assert.deepEqual(
    apps.map((app) => app.bundleId),
    ['com.c', 'com.a', 'com.b'],
  )
})

test('日期写成 年-月-日，认不出的给空的', () => {
  assert.equal(dayOf(new Date(2026, 9, 7, 23, 59).getTime()), '2026-10-07')
  assert.equal(dayOf(new Date(2026, 0, 2).toISOString()), '2026-01-02')
  assert.equal(dayOf('not a date'), '')
})

test('Windows：设备详情里不提系统权限；助手的样子和两条提醒只认助手报过的', () => {
  assert.equal(deviceHint({ platform: 'win32', helper: 'idle', permissions: null }), null)
  assert.equal(helperLook(null), 'unknown')
  assert.equal(helperLook({ platform: 'win32', helper: 'ready', permissions: null }), 'running')
  assert.equal(helperLook({ platform: 'win32', helper: 'idle', permissions: null }), 'idle')
  assert.equal(
    helperLook({ platform: 'win32', helper: 'failed', permissions: null, reason: 'x' }),
    'failed',
  )
  assert.deepEqual(winWarnings({ platform: 'win32', helper: 'idle', permissions: null }), [])
  const info = { pid: 1, version: '0.9.0', integrity: 'medium', uacEnabled: true }
  assert.deepEqual(
    winWarnings({ platform: 'win32', helper: 'ready', permissions: null, windows: info }),
    [],
  )
  assert.deepEqual(
    winWarnings({
      platform: 'win32',
      helper: 'ready',
      permissions: null,
      windows: { ...info, integrity: 'high', uacEnabled: false },
    }),
    ['admin', 'uac'],
  )
})
