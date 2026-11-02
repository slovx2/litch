import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkNightly, checkVersion } from './release-policy.mjs'

const sha = 'a'.repeat(40)
const nightly = { id: 123, conclusion: 'failure', html_url: 'https://example.test/run/123' }
const input = { nightly, sha, blockers: [] }
test('夜间未知首次接入警告，失败必须拦，已知问题不能被绿灯掩盖', () => {
  assert.match(checkNightly({ ...input, nightly: null }), /首次接入/)
  assert.throws(() => checkNightly(input), /须同 SHA/)
  assert.throws(
    () =>
      checkNightly({
        ...input,
        nightly: { ...nightly, conclusion: 'success' },
        blockers: [{ html_url: 'issue' }],
      }),
    /release-blocker/,
  )
  assert.match(checkNightly({ ...input, fullPassed: { html_url: 'full' } }), /完整 Full 已通过/)
})
test('分诊必须属于这个候选与这次夜间，含理由且维护者已关闭', () => {
  const record = {
    nightlyRun: 123,
    candidateSha: sha,
    disposition: 'unrelated',
    reason: '已检查失败的功能与候选变更及依赖均无关联，附独立复现结果。',
  }
  const triage = {
    state: 'closed',
    labels: [{ name: 'nightly-triage' }],
    body: JSON.stringify(record),
    authorized: true,
    html_url: 'issue',
  }
  assert.match(checkNightly({ ...input, triage }), /已分诊/)
  for (const changed of [
    { state: 'open' },
    { authorized: false },
    { labels: [] },
    { body: '{}' },
    { body: JSON.stringify({ ...record, candidateSha: 'b'.repeat(40) }) },
    { body: JSON.stringify({ ...record, nightlyRun: 124 }) },
  ]) {
    assert.throws(() => checkNightly({ ...input, triage: { ...triage, ...changed } }), /须同 SHA/)
  }
})
test('发布版本严格递增，不能覆盖已公开的同版本', () => {
  checkVersion('v0.29.0', 'v0.28.9')
  checkVersion('v1.0.0', 'v0.99.99')
  for (const tag of ['v0.28.1', 'v0.28.2', 'v0.28.3-beta', 'main']) {
    assert.throws(() => checkVersion(tag, 'v0.28.2'))
  }
})
