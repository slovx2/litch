import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, test } from 'node:test'
import { experiment } from '../src/experiment.ts'
import { remoteDev, setRemoteDev } from '../src/platform/dev.ts'
import { devToolsEnabled, productionPrefs } from '../src/shell/build-mode.ts'
import { handleDevLink } from '../src/shell/dev-links.ts'
import { jsonFile } from '../src/shell/json-file.ts'
import { feedOverride, onFeedOverride, setFeedOverride } from '../src/update/override.ts'

afterEach(() => {
  process.env.EXPO_PUBLIC_LITCH_E2E = '1'
})

test('发布包忽略所有开发链接，非法 URL 不造成崩溃', () => {
  process.env.EXPO_PUBLIC_LITCH_E2E = '0'
  const sent = []
  const services = { channel: { command: (...args) => sent.push(args) } }
  for (const host of [
    'boot?mode=mock',
    'boot?mode=fixture',
    'remote?adapter=evil',
    'new?prompt=hi',
    'send?text=hi',
    'spawn?parent=x',
    'bench',
    'test-anr',
    'test-terminal',
    'seed?count=300',
    'update?feed=https://invalid.test/feed',
    'terminal',
  ])
    assert.equal(handleDevLink(`litch://${host}`, services), null)
  assert.equal(handleDevLink('not a URL', services), null)
  assert.deepEqual(sent, [])
})

test('未设置/拼错构建变量默认关闭；只有 E2E 显式 1 开放', () => {
  for (const value of [undefined, '0', 'true', 'yes']) {
    if (value === undefined) delete process.env.EXPO_PUBLIC_LITCH_E2E
    else process.env.EXPO_PUBLIC_LITCH_E2E = value
    assert.equal(devToolsEnabled(), false)
    assert.equal(productionPrefs({ boot: 'fixture', lang: 'en' }).boot, 'stored')
  }
  process.env.EXPO_PUBLIC_LITCH_E2E = '1'
  assert.equal(handleDevLink('litch-dev://boot?mode=fixture', null), 'fixture')
  assert.equal(handleDevLink('https://boot?mode=fixture', null), null)
  assert.equal(handleDevLink('litch://user:password@boot?mode=fixture', null), null)
  assert.equal(handleDevLink('bad url', null), null)
})

test('同一条外部链接：发布包没有写入或通知，E2E 包允许换源、远端和实验参数', () => {
  const original = { ...experiment }
  let notifications = 0
  const stop = onFeedOverride(() => notifications++)
  try {
    for (const value of ['0', '1']) {
      process.env.EXPO_PUBLIC_LITCH_E2E = value
      jsonFile('update-feed.json').remove()
      jsonFile('remote-dev.json').remove()
      experiment.markers = false
      notifications = 0
      for (const scheme of ['litch', 'litch-dev']) {
        handleDevLink(`${scheme}://update?feed=http://127.0.0.1:8765/feed&markers=1`, null)
        handleDevLink(`${scheme}://remote?adapter=fixture&env=TEST_MODE=1`, null)
      }
      const enabled = value === '1'
      assert.equal(notifications, enabled ? 2 : 0)
      assert.equal(experiment.markers, enabled)
      assert.deepEqual(
        jsonFile('update-feed.json').read(),
        enabled ? { feed: 'http://127.0.0.1:8765/feed' } : null,
      )
      assert.deepEqual(
        jsonFile('remote-dev.json').read(),
        enabled ? { adapter: 'fixture', env: { TEST_MODE: '1' } } : null,
      )
    }
  } finally {
    stop()
    Object.assign(experiment, original)
    jsonFile('update-feed.json').remove()
    jsonFile('remote-dev.json').remove()
  }
})

test('升级后的远端开发配置和更新源被清除，发布包不能重新写入', () => {
  process.env.EXPO_PUBLIC_LITCH_E2E = '1'
  setRemoteDev(new URLSearchParams('adapter=fixture&env=TEST_MODE=1'))
  setFeedOverride('https://invalid.test/feed')
  assert.equal(remoteDev().adapter, 'fixture')
  process.env.EXPO_PUBLIC_LITCH_E2E = '0'
  assert.deepEqual(remoteDev(), {})
  assert.equal(feedOverride(), null)
  assert.equal(jsonFile('remote-dev.json').read(), null)
  assert.equal(jsonFile('update-feed.json').read(), null)
  setRemoteDev(new URLSearchParams('adapter=evil'))
  assert.equal(setFeedOverride('https://invalid.test/feed'), false)
  assert.deepEqual(remoteDev(), {})
})

test('终端不再启用私有属性，依赖补丁删除私有实现', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const terminal = read('../src/screens/tools/terminal/TerminalView.tsx')
  assert.doesNotMatch(terminal, /keyboardDisplayRequiresUserAction|hideKeyboardAccessoryView/)
  const patch = read('../patches/react-native-webview+13.16.1.patch')
  assert.match(patch, /^-.*_elementDidFocus:/m)
  assert.match(patch, /^-.*object_setClass/m)
  assert.doesNotMatch(patch, /^\+.*(?:_elementDidFocus|_startAssistingNode|object_setClass)/m)
})
