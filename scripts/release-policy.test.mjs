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

test('修复版政策不查询夜间，仍重查blocker与正式基线；没有patch证明不能借环境变量绕过', async (t) => {
  const { releasePolicy } = await import('./release-policy.mjs')
  for (const [key, value] of Object.entries({
    GITHUB_REPOSITORY: 'fixture/repo',
    CANDIDATE_SHA: sha,
    TAG: '',
    GITHUB_STEP_SUMMARY: '',
    RELEASE_MODE: 'patch',
  })) {
    const old = process.env[key]
    process.env[key] = value
    t.after(() => {
      if (old === undefined) delete process.env[key]
      else process.env[key] = old
    })
  }
  const gate = { mode: 'patch', baseline: { tag: 'v0.30.0', candidateVersion: '0.30.1' } }
  const calls = []
  let blockers = []
  const services = {
    api(path) {
      calls.push(path)
      assert.match(path, /issues\?labels=release-blocker/)
      return blockers
    },
    verifyPatchBase(input) {
      assert.equal(input.expected, gate.baseline)
      assert.equal(input.branch, 'release/0.30.1')
      return { url: 'release', commits: [sha] }
    },
  }
  assert.match(await releasePolicy({ gate, branch: 'release/0.30.1' }, services), /不依赖夜间分诊/)
  assert.equal(calls.length, 1)
  blockers = [{ number: 1 }]
  await assert.rejects(releasePolicy({ gate }, services), /release-blocker/)
  await assert.rejects(releasePolicy({}, services), /issues/)
})

test('显式手动绕过不查询检查门禁，仍拒绝标签SHA错配和覆盖已公开版本', async (t) => {
  const { releasePolicy } = await import('./release-policy.mjs')
  const { gateBypass } = await import('./ci/gate-bypass.mjs')
  const context = { repository: 'fixture/repo', sha, runId: 42, attempt: 1 }
  for (const [key, value] of Object.entries({
    GITHUB_REPOSITORY: context.repository,
    CANDIDATE_SHA: sha,
    TAG: 'v1.2.3',
  })) {
    const old = process.env[key]
    process.env[key] = value
    t.after(() => {
      if (old === undefined) delete process.env[key]
      else process.env[key] = old
    })
  }
  const gate = gateBypass(context, {
    BYPASS_GATE: 'true',
    BYPASS_REASON: '本地检查通过',
    GITHUB_ACTOR: 'maintainer',
  })
  let actualSha = sha
  let published = false
  const services = {
    api(path) {
      if (path.includes('matching-refs')) return [{ ref: 'refs/tags/v1.2.3' }]
      if (path.includes('/commits/')) return { sha: actualSha }
      if (path.includes('/releases?')) return published ? [{ tag_name: 'v1.2.3' }] : []
      throw new Error(`不应访问检查门禁：${path}`)
    },
  }
  const input = { gate, candidateFull: { run: { id: 42, run_attempt: 1 } } }
  assert.match(await releasePolicy(input, services), /手动绕过/)
  actualSha = 'b'.repeat(40)
  await assert.rejects(releasePolicy(input, services), /标签已移动/)
  actualSha = sha
  published = true
  await assert.rejects(releasePolicy(input, services), /已经公开/)
})
