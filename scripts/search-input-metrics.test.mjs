import assert from 'node:assert/strict'
import test from 'node:test'
import { inputMetrics } from './search-input-metrics.mjs'

test('单次调度尖峰仍完整报告，不把一次 186.7ms 当成整组的响应速度', () => {
  const metrics = inputMetrics([10, 12, 9, 11, 13, 8, 14, 10, 12, 11, 186.7])
  assert.equal(metrics.p50, 11)
  assert.equal(metrics.p90, 14)
  assert.equal(metrics.max, 186.7)
  assert.equal(metrics.samples.length, 11)
  assert.equal(metrics.exceedsReference, false)
})

test('达到或超过 100ms 只如实记录，不把共享 runner 的计时作为门禁', () => {
  for (const samples of [[10, 12, 9, 11, 13, 8, 14, 10, 12, 100, 186.7], Array(11).fill(186.7)]) {
    const metrics = inputMetrics(samples)
    assert.equal(metrics.exceedsReference, true)
    assert.equal(metrics.referenceMs, 100)
    assert.deepEqual(metrics.samples, samples)
  }
})

test('诊断数据仍须有完整、有效的采样', () => {
  assert.throws(() => inputMetrics([1]), /采样数不足/)
  assert.throws(() => inputMetrics([...Array(10).fill(1), NaN]), /样本无效/)
})
