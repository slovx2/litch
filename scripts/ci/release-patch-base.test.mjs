import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { checkPatchHistory, checkPatchRecord, verifyPatchBase } from './release-patch-base.mjs'

const baseSha = 'a'.repeat(40)
const sha = 'b'.repeat(40)
function fixture() {
  const input = {
    repository: 'fixture/repo',
    sha,
    version: '0.30.1',
    branch: 'release/0.30.1',
    tag: 'v0.30.0',
  }
  const manifest = {
    schema: 2,
    repository: input.repository,
    sha: baseSha,
    version: '0.30.0',
    runId: '42',
    attempt: 1,
    gate: { sha: baseSha, conclusion: 'success' },
  }
  const raw = JSON.stringify(manifest)
  const asset = {
    id: 7,
    name: 'candidate.json',
    size: Buffer.byteLength(raw),
    digest: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
  }
  const release = {
    id: 6,
    tag_name: input.tag,
    draft: false,
    prerelease: false,
    published_at: '2026-01-01T00:00:00Z',
    html_url: 'https://example.test/v0.30.0',
  }
  const run = {
    repository: { full_name: input.repository },
    path: '.github/workflows/release.yml',
    event: 'workflow_dispatch',
    head_sha: baseSha,
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
  }
  const compare = {
    status: 'ahead',
    behind_by: 0,
    merge_base_commit: { sha: baseSha },
    total_commits: 1,
    commits: [{ sha, parents: [{ sha: baseSha }] }],
  }
  const calls = []
  const records = {
    'issues?labels=release-blocker&state=open&per_page=100': [],
    'releases/latest': release,
    'commits/refs%2Ftags%2Fv0.30.0': { sha: baseSha },
    'releases/6/assets?per_page=100': [asset],
    'actions/runs/42': run,
    [`contents/package.json?ref=${sha}`]: {
      content: Buffer.from(JSON.stringify({ version: input.version })).toString('base64'),
    },
    [`compare/${baseSha}...${sha}`]: compare,
  }
  const services = {
    api(path) {
      calls.push(path)
      const key = path.replace('repos/fixture/repo/', '')
      assert.ok(Object.hasOwn(records, key), `意外 API：${path}`)
      return records[key]
    },
    readAsset(path) {
      assert.equal(path, 'repos/fixture/repo/releases/assets/7')
      return raw
    },
  }
  return { input, services, records, calls, release, asset, run, compare }
}

test('正式版基线独立于夜间、48小时和Actions制品保留期，绑定公开清单与候选', () => {
  const f = fixture()
  const base = verifyPatchBase(f.input, f.services)
  assert.equal(base.sha, baseSha)
  assert.equal(base.kind, 'release')
  assert.deepEqual(base.commits, [sha])
  assert.ok(!f.calls.some((path) => /nightly|schedule|artifacts/.test(path)))
  assert.deepEqual(verifyPatchBase({ ...f.input, expected: base }, f.services), base)
  assert.throws(
    () => verifyPatchBase({ ...f.input, expected: { ...base, releaseId: 123 } }, f.services),
    /已变化/,
  )
})

test('拒绝草稿、预发布、过旧基线、移动标签、篡改清单、失败或重跑的基线', () => {
  for (const mutate of [
    (f) => {
      f.release.draft = true
    },
    (f) => {
      f.release.prerelease = true
    },
    (f) => {
      f.release.tag_name = 'v0.30.1'
    },
    (f) => {
      f.release.published_at = null
    },
    (f) => {
      f.records['commits/refs%2Ftags%2Fv0.30.0'].sha = sha
    },
    (f) => {
      f.asset.digest = `sha256:${'c'.repeat(64)}`
    },
    (f) => {
      delete f.asset.digest
    },
    (f) => {
      f.asset.size++
    },
    (f) => {
      f.run.conclusion = 'failure'
    },
    (f) => {
      f.run.run_attempt = 2
    },
    (f) => {
      f.run.path = '.github/workflows/full.yml'
    },
    (f) => {
      f.records['issues?labels=release-blocker&state=open&per_page=100'] = [{ number: 1 }]
    },
  ]) {
    const f = fixture()
    mutate(f)
    assert.throws(() => verifyPatchBase(f.input, f.services))
  }
})

test('只有下一补丁版本和专属release分支可用，版本来自候选源码', () => {
  for (const change of [
    { version: '0.31.0' },
    { version: '0.30.2' },
    { version: '0.30.0' },
    { branch: 'main' },
    { version: '0.30.1-beta' },
  ]) {
    const f = fixture()
    assert.throws(() => verifyPatchBase({ ...f.input, ...change }, f.services))
  }
  const f = fixture()
  const base = verifyPatchBase(f.input, f.services)
  for (const change of [
    { candidateVersion: '0.31.0', branch: 'release/0.31.0' },
    { candidateSha: baseSha },
    { kind: 'nightly' },
    { commits: [] },
  ]) {
    assert.throws(() => checkPatchRecord({ ...base, ...change }, f.input))
  }
})

test('最多5个连续单父提交，拒绝第6个、merge、分叉、截断及错误末端', () => {
  const f = fixture()
  const hashes = Array.from({ length: 5 }, (_, i) => String(i + 1).repeat(40))
  const commits = hashes.map((value, i) => ({
    sha: value,
    parents: [{ sha: i ? hashes[i - 1] : baseSha }],
  }))
  const compare = { ...f.compare, total_commits: 5, commits }
  assert.deepEqual(checkPatchHistory(compare, baseSha, hashes[4]), hashes)
  for (const change of [
    { total_commits: 6 },
    { total_commits: 0 },
    { status: 'diverged' },
    { behind_by: 1 },
    { merge_base_commit: { sha } },
    { commits: commits.slice(1) },
    { commits: [{ ...commits[0], parents: [{ sha: baseSha }, { sha }] }, ...commits.slice(1)] },
    { commits: [{ ...commits[0], parents: [{ sha }] }, ...commits.slice(1)] },
  ])
    assert.throws(() => checkPatchHistory({ ...compare, ...change }, baseSha, hashes[4]))
  assert.throws(() => checkPatchHistory(compare, baseSha, sha))
})
