import assert from 'node:assert/strict'
import test from 'node:test'
import { powerShortcutTitle, powerStatusLine } from '../src/devices/power-shortcut.ts'
import { translator } from '../src/i18n/index.ts'

const power = (powerSource) => ({
  supported: true,
  state: 'inactive',
  powerSource,
  reasons: [],
  text: { 'zh-CN': '服务状态', en: 'Service status' },
})

test('快捷开关提示区分配置开启与当前供电；离线不显示过期供电和已申请状态', () => {
  const t = translator('zh-CN')
  const battery = powerShortcutTitle(power('battery'), true, true, t)
  assert.match(battery, /常开已启用/)
  assert.match(battery, /正在使用电池/)
  assert.match(battery, /接通电源后生效/)
  const ac = powerShortcutTitle(power('ac'), true, true, t)
  assert.match(ac, /已接通电源/)
  assert.doesNotMatch(ac, /接通电源后生效/)
  const offline = powerShortcutTitle(power('ac'), true, false, t)
  assert.doesNotMatch(offline, /已接通电源|服务状态/)
})

test('英文提示包含开关状态、供电未知、耗电影响', () => {
  const text = powerShortcutTitle(power('unknown'), false, true, translator('en'))
  assert.match(text, /Always-on disabled/)
  assert.match(text, /Power source unknown/)
  assert.match(text, /uses more energy/)
})

test('状态行：开了接电常开、正用电池、没有别的来源时写接通电源后生效；其余照服务的原话', () => {
  const t = translator('zh-CN')
  assert.equal(powerStatusLine(power('battery'), true, t), '正在使用电池 · 接通电源后生效')
  assert.equal(powerStatusLine(power('battery'), false, t), '服务状态')
  assert.equal(powerStatusLine(power('ac'), true, t), '服务状态')
  const working = { ...power('battery'), state: 'requested', reasons: ['working'] }
  assert.equal(powerStatusLine(working, true, t), '服务状态')
})
