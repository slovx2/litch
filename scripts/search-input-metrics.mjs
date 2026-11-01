import assert from 'node:assert/strict'

export const INPUT_SAMPLES = 11
// 仅用于报告对照，不作为 CI 门槛。
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
  return {
    samples,
    p50: percentile(0.5),
    p90: percentile(0.9),
    max: sorted.at(-1),
    referenceMs: INPUT_BUDGET_MS,
    exceedsReference: percentile(0.9) >= INPUT_BUDGET_MS,
  }
}
