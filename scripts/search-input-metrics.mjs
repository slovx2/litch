import assert from 'node:assert/strict'

export const INPUT_SAMPLES = 11
export const INPUT_BUDGET_MS = 100

/** 同一种真实输入切换的热样本；保留全部原值和最大值，单次抖动不能被报告隐藏。 */
export function inputMetrics(samples) {
  assert.equal(samples.length, INPUT_SAMPLES, '输入响应采样数不足')
  assert.ok(
    samples.every((value) => Number.isFinite(value) && value >= 0),
    '输入响应样本无效',
  )
  const sorted = [...samples].sort((a, b) => a - b)
  const percentile = (p) => sorted[Math.ceil(sorted.length * p) - 1]
  return { samples, p50: percentile(0.5), p90: percentile(0.9), max: sorted.at(-1) }
}

export function checkInputBudget(name, metrics) {
  assert.ok(
    metrics.p90 < INPUT_BUDGET_MS,
    `${name} 输入响应 p90 ${metrics.p90}ms（须 <${INPUT_BUDGET_MS}ms；样本 ${metrics.samples.join(', ')}）`,
  )
}
