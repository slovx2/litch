import assert from 'node:assert/strict'
import test from 'node:test'
import { metrics } from './metrics.mjs'

test('并发工具取并集，非工具残差不等于模型推理时间', () => {
  const call = (start, durationMs, success = true) => ({
    at: new Date(start).toISOString(),
    durationMs,
    result: { success, contentItems: [] },
  })
  assert.deepEqual(
    metrics([call(100, 100), call(150, 100), call(300, 20, false)], [{ durationMs: 500 }]),
    {
      calls: 3,
      failures: 1,
      toolMs: 220,
      occupiedMs: 170,
      wallMs: 500,
      outsideToolMs: 330,
      noChanges: 0,
    },
  )
})

test('零调用回合仍保留墙钟；无变化只是线索，不自动判失败', () => {
  assert.equal(metrics([], [{ durationMs: 100 }]).outsideToolMs, 100)
  const row = {
    at: new Date(0).toISOString(),
    durationMs: 5,
    result: {
      success: true,
      contentItems: [{ type: 'inputText', text: '(no changes since the last state)' }],
    },
  }
  assert.equal(metrics([row], [{ durationMs: 10 }]).noChanges, 1)
  assert.equal(metrics([row], [{ durationMs: 10 }]).failures, 0)
})
