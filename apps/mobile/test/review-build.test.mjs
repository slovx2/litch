import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, test } from 'node:test'
import { remoteDev, setRemoteDev } from '../src/platform/dev.ts'
import { devToolsEnabled, productionPrefs } from '../src/shell/build-mode.ts'
import { handleDevLink } from '../src/shell/dev-links.ts'
import { jsonFile } from '../src/shell/json-file.ts'
import { feedOverride, setFeedOverride } from '../src/update/override.ts'

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
