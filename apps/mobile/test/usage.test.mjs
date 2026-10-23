// 用量页和“压缩上下文”的判断（src/detail/usage/logic.ts）：说法照桌面端，压缩入口什么时候出
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { translator } from '../../../packages/ui/src/i18n/index.ts'
import {
  compaction,
  contextLine,
  contextPercent,
  limitLines,
  usageLevel,
} from '../src/detail/usage/logic.ts'
import { zhCN as usage, en as usageEn } from '../src/ui/messages/usage.ts'

const t = translator('zh-CN')
const HOUR = 3_600_000

test('上下文：报了窗口才有百分比，写短词元数；没报说还没有', () => {
  assert.equal(contextPercent({ usedTokens: 84_000, windowTokens: 200_000 }), 42)
  assert.equal(contextPercent({ usedTokens: 900, windowTokens: null }), null)
  assert.equal(contextPercent(null), null)
  assert.deepEqual(contextLine({ usedTokens: 84_000, windowTokens: 200_000 }, t), {
    id: 'context',
    label: '上下文',
    percent: 42,
    detail: '84k / 200k',
  })
  assert.equal(contextLine(null, t).detail, '尚未报告上下文用量')
})

test('账号额度：窗口的名字、用了多少、多久后重置（和桌面同样的说法）', () => {
  const now = Date.UTC(2026, 9, 24, 8, 0)
  const lines = limitLines(
    [
      {
        id: ':primary',
        name: null,
        window: { usedPercent: 34, windowMins: 300, resetsAt: now + 2 * HOUR + 13 * 60_000 },
      },
      {
        id: ':secondary',
        name: null,
        window: { usedPercent: 91, windowMins: 7 * 1440, resetsAt: now + 4 * 24 * HOUR },
      },
      {
        id: 'opus:primary',
        name: 'Opus',
        window: { usedPercent: 5, windowMins: null, resetsAt: null },
      },
    ],
    now,
    t,
  )
  assert.deepEqual(
    lines.map((line) => [line.label, line.percent, line.detail]),
    [
      ['5 小时额度', 34, '2 小时 13 分后重置'],
      ['每周额度', 91, '4 天 0 小时后重置'],
      ['Opus · 额度', 5, null],
    ],
  )
  assert.deepEqual(
    lines.map((line) => usageLevel(line.percent)),
    ['normal', 'full', 'normal'],
  )
  assert.equal(usageLevel(70), 'high')
  assert.equal(usageLevel(null), 'normal')
})

test('压缩：声明了不会、试过不认识的不出入口；回合在跑时出但说为什么压不了', () => {
  assert.deepEqual(compaction({ compact: true, declared: true }, false), {
    shown: true,
    blocked: null,
  })
  assert.deepEqual(compaction({ compact: true, declared: false }, true), {
    shown: true,
    blocked: 'context.compactBusy',
  })
  assert.equal(compaction({ compact: false, declared: true }, false).shown, false)
  assert.equal(compaction({ compact: false, declared: false }, false).shown, false)
  // 会话不在线（详情页给的是 undefined）
  assert.equal(compaction(undefined, false).shown, false)
  assert.equal(t('context.compactBusy'), '回合进行中，结束后可压缩')
})

test('用量文案中英文的键一致', () => {
  assert.deepEqual(Object.keys(usageEn).sort(), Object.keys(usage).sort())
})
