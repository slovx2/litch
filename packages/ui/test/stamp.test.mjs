// 消息上的时刻（src/app/format.ts 的 stamp、stampFull、turnEnded）：当天只写时刻、六天内带星期、更早带月日、
// 不是今年再带年；回合结束的时刻是开始加用时。时刻都按本地时间建，换时区跑结果一样。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { stamp, stampFull, turnEnded } = await import('../src/app/format.ts')

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
