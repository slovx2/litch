import assert from 'node:assert/strict'
import test from 'node:test'
import { checkInputBudget, inputMetrics } from './search-input-metrics.mjs'

test('单次调度尖峰仍完整报告，不把一次 186.7ms 当成整组的响应速度', () => {
  const metrics = inputMetrics([10, 12, 9, 11, 13, 8, 14, 10, 12, 11, 186.7])
  assert.equal(metrics.p50, 11)
  assert.equal(metrics.p90, 14)
  assert.equal(metrics.max, 186.7)
  assert.equal(metrics.samples.length, 11)
  checkInputBudget('ProcessNeedle', metrics)
})

test('重复超过 100ms 仍失败，100ms 边界也不放宽', () => {
  for (const samples of [[10, 12, 9, 11, 13, 8, 14, 10, 12, 100, 186.7], Array(11).fill(186.7)]) {
    assert.throws(() => checkInputBudget('ProcessNeedle', inputMetrics(samples)), /须 <100ms/)
  }
})

test('不能靠少采样或非数值绕过性能检查', () => {
  assert.throws(() => inputMetrics([1]), /采样数不足/)
  assert.throws(() => inputMetrics([...Array(10).fill(1), NaN]), /样本无效/)
})
