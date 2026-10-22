// 用量环弹层里账号额度的字（composer/limits.ts）：窗口叫什么、多久之后重置。用真的中英文文案。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { resetsIn, windowLabel } = await import('../src/composer/limits.ts')
const { translator } = await import('../src/i18n/index.ts')

const zh = translator('zh-CN')
const en = translator('en')
const window = (windowMins) => ({ usedPercent: 10, windowMins, resetsAt: null })
const MINUTE = 60_000

test('LIMITS-UI-001 窗口按长短起名：5 小时额度、每周额度、整天的写天数，说不出的只写“额度”', () => {
  assert.equal(windowLabel(window(300), zh), '5 小时额度')
  assert.equal(windowLabel(window(10080), zh), '每周额度')
  assert.equal(windowLabel(window(1440), zh), '1 天额度')
  assert.equal(windowLabel(window(null), zh), '额度')
  assert.equal(windowLabel(window(45), zh), '额度')
  assert.equal(windowLabel(window(300), en), '5-hour limit')
  assert.equal(windowLabel(window(10080), en), 'Weekly limit')
})

test('LIMITS-UI-002 重置时间写相对时间：分钟、小时加分、天加小时；不到一分钟和已经过了的写“即将重置”', () => {
  const now = 1_800_000_000_000
  assert.equal(resetsIn(null, now, zh), null, '对面没说什么时候重置就不写')
  assert.equal(resetsIn(now + 133 * MINUTE + 20_000, now, zh), '2 小时 13 分后重置')
  assert.equal(resetsIn(now + 41 * MINUTE, now, zh), '41 分钟后重置')
  assert.equal(resetsIn(now + (4 * 1440 + 185) * MINUTE, now, zh), '4 天 3 小时后重置')
  assert.equal(resetsIn(now + 30_000, now, zh), '即将重置')
  assert.equal(resetsIn(now - MINUTE, now, zh), '即将重置')
  assert.equal(resetsIn(now + 133 * MINUTE, now, en), 'Resets in 2h 13m')
  assert.equal(resetsIn(now + (4 * 1440 + 185) * MINUTE, now, en), 'Resets in 4d 3h')
})
