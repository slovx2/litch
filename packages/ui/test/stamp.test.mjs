// 消息上的时刻（src/app/format.ts 的 stamp、stampFull、turnEnded）：当天只写时刻、六天内带星期、更早带月日、
// 不是今年再带年；回合结束的时刻是开始加用时。时刻都按本地时间建，换时区跑结果一样。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { translator } from '../src/i18n/index.ts'

const { agoLong, stamp, stampFull, turnEnded } = await import('../src/app/format.ts')

const at = (y, m, d, h = 14, min = 32) => new Date(y, m - 1, d, h, min).getTime()
const now = at(2026, 10, 27, 20, 0)

test('当天只写时刻，六天内写星期，更早写月日，跨年带年', () => {
  assert.equal(stamp(at(2026, 10, 27), now, 'zh-CN'), '14:32')
  assert.equal(stamp(at(2026, 10, 26, 23, 59), now, 'zh-CN'), '星期一 23:59', '昨天也写星期')
  assert.equal(stamp(at(2026, 10, 21), now, 'zh-CN'), '星期三 14:32')
  assert.equal(stamp(at(2026, 10, 20), now, 'zh-CN'), '10月20日 14:32')
  assert.equal(stamp(at(2025, 12, 31), now, 'zh-CN'), '2025年12月31日 14:32')
  assert.equal(stamp(at(2026, 10, 27), now, 'en'), '2:32 PM')
  assert.equal(stamp(at(2026, 10, 20), now, 'en'), 'Oct 20, 2:32 PM')
  assert.equal(stamp(at(2026, 10, 28), now, 'zh-CN'), '14:32', '对面时钟快了：按当天')
})

test('完整写法带年月日', () => {
  assert.equal(stampFull(at(2026, 10, 27), 'zh-CN'), '2026年10月27日 14:32')
})

test('回合结束的时刻：开始加用时；在跑的、缺一样的是 null', () => {
  const start = at(2026, 10, 27)
  assert.equal(
    turnEnded({ status: 'completed', startedAt: start, durationMs: 63_000 }),
    start + 63_000,
  )
  assert.equal(turnEnded({ status: 'interrupted', startedAt: start, durationMs: 1 }), start + 1)
  assert.equal(turnEnded({ status: 'running', startedAt: start, durationMs: null }), null)
  assert.equal(turnEnded({ status: 'completed', startedAt: null, durationMs: 5 }), null)
  assert.equal(turnEnded({ status: 'completed', startedAt: start, durationMs: null }), null)
})

test('没有 RelativeTimeFormat 时仍能显示近期建议的创建时间', (context) => {
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'RelativeTimeFormat')
  context.after(() => Object.defineProperty(Intl, 'RelativeTimeFormat', descriptor))
  delete Intl.RelativeTimeFormat
  const zh = translator('zh-CN')
  const en = translator('en')
  const minute = 60_000
  const day = 24 * 60 * minute
  const proposal = { createdAt: now - 7 * minute }
  assert.equal(agoLong(proposal.createdAt, now, zh), '7分钟前')
  assert.equal(agoLong(proposal.createdAt, now, en), '7 minutes ago')
  assert.equal(agoLong(now - minute, now, en), '1 minute ago')
  assert.equal(agoLong(now - (6 * 60 + 16) * minute, now, zh), '6小时前')
  assert.equal(agoLong(now - 10_000, now, en), 'now')
  assert.equal(agoLong(now - day, now, en), 'yesterday')
  assert.equal(agoLong(now - 2 * day, now, zh), '前天')
  assert.equal(agoLong(now - 7 * day, now, zh), stamp(now - 7 * day, now, zh.lang))
})
