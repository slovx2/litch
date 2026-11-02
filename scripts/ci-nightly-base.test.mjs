import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectNightlyBase } from './ci-nightly-base.mjs'

const now = Date.parse('2026-11-02T12:00:00Z')
const run = {
  id: 42,
  head_sha: 'a'.repeat(40),
  path: '.github/workflows/full.yml',
  event: 'schedule',
  status: 'completed',
  conclusion: 'success',
  updated_at: '2026-11-02T00:00:00Z',
  html_url: 'https://example.test/42',
  run_attempt: 1,
}
const options = { now, isAncestor: () => true }
test('48 小时内最近一次成功的祖先夜间，绑定真实 run ID', () => {
  const result = selectNightlyBase([run], options)
  assert.equal(result.sha, run.head_sha)
  assert.equal(result.run, 42)
  assert.equal(result.attempt, 1)
})
test('非祖先不可复用，可以退到稍早但仍新鲜的祖先', () => {
  const other = { ...run, id: 43, head_sha: 'b'.repeat(40), updated_at: '2026-11-02T01:00:00Z' }
  assert.match(
    selectNightlyBase([other], { now, isAncestor: () => false }).reason,
    /不是候选的祖先/,
  )
  assert.equal(
    selectNightlyBase([run, other], { now, isAncestor: (sha) => sha === run.head_sha }).run,
    42,
  )
})
test('过期、没有历史和无效时间均回退全量', () => {
  for (const updated_at of ['2026-10-31T11:59:59Z', '2026-11-03T00:00:00Z', 'invalid']) {
    assert.equal(selectNightlyBase([{ ...run, updated_at }], options).sha, null)
  }
  assert.equal(selectNightlyBase([], options).sha, null)
  assert.equal(
    selectNightlyBase([{ ...run, updated_at: '2026-10-31T12:00:00Z' }], options).sha,
    run.head_sha,
  )
})
test('红灯、手动按领域调用或其他工作流不能当成功完整夜间', () => {
  for (const changes of [
    { conclusion: 'failure' },
    { event: 'workflow_call' },
    { event: 'workflow_dispatch' },
    { status: 'in_progress' },
    { path: '.github/workflows/gate.yml' },
  ]) {
    assert.equal(selectNightlyBase([{ ...run, ...changes }], options).sha, null)
  }
  // 找到较早绿灯不代表可发布；最新红灯另由 release-policy 独立拦截。
  assert.equal(selectNightlyBase([run, { ...run, id: 43, conclusion: 'failure' }], options).run, 42)
})
