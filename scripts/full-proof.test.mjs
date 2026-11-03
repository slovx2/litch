import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  fixtureLinuxProofs,
  fixtureMacProof,
  fixtureWindowsProof,
} from './ci/mac-proof-fixture.mjs'
import { domains } from './ci-impact.mjs'
import {
  findSuccessfulFull,
  fullJobs,
  hasAllDomains,
  isCompleteFull,
  writeFullProof,
} from './full-proof.mjs'
import { decodeFullProofArchive, readFullProofArtifact } from './full-proof-artifact.mjs'
import { checkNightly } from './release-policy.mjs'

const sha = 'a'.repeat(40)
const repository = 'test/litch'
const run = {
  id: 456,
  run_attempt: 2,
  path: '.github/workflows/full.yml',
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
  head_sha: sha,
  html_url: 'https://example.test/run/456',
}
const proof = {
  schema: 1,
  repository,
  runId: run.id,
  attempt: 2,
  event: run.event,
  workflowSha: sha,
  sha,
  domains: '',
  runCi: true,
  jobs: Object.fromEntries(fullJobs.map((job) => [job, 'success'])),
}
proof.macProof = fixtureMacProof(proof)
proof.linuxProofs = fixtureLinuxProofs(proof)
proof.windowsProof = fixtureWindowsProof(proof)

test('默认全量、显式全集和 schedule 都可证明同 SHA 完整 Full', () => {
  assert.ok(isCompleteFull(run, proof, sha, repository))
  assert.ok(
    isCompleteFull(
      run,
      { ...proof, domains: JSON.stringify([...domains].reverse()) },
      sha,
      repository,
    ),
  )
  assert.ok(
    isCompleteFull({ ...run, event: 'schedule' }, { ...proof, event: 'schedule' }, sha, repository),
  )
})

test('mobile-only、缺领域、额外或重复领域和无法读取的输入不能算全量', () => {
  for (const selected of [
    '["mobile"]',
    JSON.stringify(domains.slice(1)),
    JSON.stringify([...domains, 'extra']),
    JSON.stringify([...domains.slice(1), 'mobile']),
    'null',
    '{}',
    'broken',
    undefined,
  ]) {
    assert.equal(hasAllDomains(selected), false)
    assert.equal(isCompleteFull(run, { ...proof, domains: selected }, sha, repository), false)
  }
})

test('run-ci 必须为 true；跳过、失败或缺失任何领域均不放行', () => {
  assert.equal(isCompleteFull(run, { ...proof, windowsProof: null }, sha, repository), false)
  for (const runCi of [false, 'true', undefined]) {
    assert.equal(isCompleteFull(run, { ...proof, runCi }, sha, repository), false)
  }
  for (const job of fullJobs) {
    for (const result of ['skipped', 'failure', 'cancelled', undefined]) {
      assert.equal(
        isCompleteFull(run, { ...proof, jobs: { ...proof.jobs, [job]: result } }, sha, repository),
        false,
      )
    }
  }
})

test('看实际检出 SHA：同 head_sha 却测另一份源码不算；调度 SHA 不同但实际测候选可算', () => {
  assert.equal(isCompleteFull(run, { ...proof, sha: 'b'.repeat(40) }, sha, repository), false)
  assert.ok(
    isCompleteFull(
      { ...run, head_sha: 'b'.repeat(40) },
      {
        ...proof,
        workflowSha: 'b'.repeat(40),
        macProof: fixtureMacProof({ ...proof, workflowSha: 'b'.repeat(40) }),
      },
      sha,
      repository,
    ),
  )
})

test('缺证明、旧 attempt、其他 run/repo/workflow 的证明不能复用', () => {
  for (const changed of [
    undefined,
    { ...proof, schema: 2 },
    { ...proof, attempt: 1 },
    { ...proof, runId: 455 },
    { ...proof, repository: 'other/repo' },
    { ...proof, workflowSha: 'b'.repeat(40) },
  ]) {
    assert.equal(isCompleteFull(run, changed, sha, repository), false)
  }
  for (const changes of [
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { event: 'push' },
    { path: '.github/workflows/gate.yml' },
  ]) {
    assert.equal(isCompleteFull({ ...run, ...changes }, proof, sha, repository), false)
  }
})

test('证明缺失、下载失败、部分运行成功都不能解除夜间红灯；真正完整才可解除', async () => {
  const input = {
    sha,
    blockers: [],
    nightly: { id: 123, conclusion: 'failure', html_url: 'nightly' },
  }
  for (const load of [
    async () => undefined,
    async () => {
      throw Error('artifact 不可读')
    },
    async () => ({ ...proof, domains: '["mobile"]' }),
  ]) {
    const fullPassed = await findSuccessfulFull([run], sha, repository, load)
    assert.equal(fullPassed, undefined)
    assert.throws(() => checkNightly({ ...input, fullPassed }), /须同 SHA/)
  }
  const fullPassed = await findSuccessfulFull([run], sha, repository, async () => proof)
  assert.match(checkNightly({ ...input, fullPassed }), /完整 Full 已通过/)
})

test('artifact 绑定 run 和 attempt，过期/多个同名/其他来源拒绝，正常证明可读取', async () => {
  const artifact = {
    id: 789,
    name: 'full-proof-2',
    expired: false,
    size_in_bytes: 100,
    workflow_run: { id: run.id, head_sha: sha },
  }
  const read = (artifacts) =>
    readFullProofArtifact(
      repository,
      run,
      () => ({ artifacts }),
      async (_repo, id) => {
        assert.equal(id, 789)
        return proof
      },
    )
  assert.equal(await read([artifact]), proof)
  for (const artifacts of [
    [],
    [artifact, artifact],
    [{ ...artifact, name: 'full-proof-1' }],
    [{ ...artifact, expired: true }],
    [{ ...artifact, workflow_run: { id: 123, head_sha: sha } }],
    [{ ...artifact, workflow_run: { id: run.id, head_sha: 'b'.repeat(40) } }],
  ]) {
    assert.equal(await read(artifacts), undefined)
  }
})

test('用真实 git HEAD 生成证明，拒绝与冻结 SHA 不一致的 checkout', () => {
  const temp = mkdtempSync(join(tmpdir(), 'litch-proof-writer-'))
  const previous = process.cwd()
  try {
    execFileSync('git', ['init', '--quiet', temp])
    execFileSync('git', [
      '-C',
      temp,
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '--quiet',
      '-m',
      'fixture',
    ])
    const actualSha = execFileSync('git', ['-C', temp, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    process.chdir(temp)
    const env = {
      GITHUB_REPOSITORY: repository,
      GITHUB_RUN_ID: '456',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_SHA: sha,
      FULL_SOURCE_SHA: actualSha,
      FULL_REQUESTED_SHA: actualSha,
      FULL_DOMAINS: '',
      FULL_RUN_CI: 'true',
      FULL_NEEDS: JSON.stringify(
        Object.fromEntries(fullJobs.map((job) => [job, { result: 'success' }])),
      ),
    }
    writeFileSync(
      'check-proofs-bound.json',
      JSON.stringify({
        macProof: fixtureMacProof({ ...proof, sha: actualSha }),
        linuxProofs: fixtureLinuxProofs({ ...proof, sha: actualSha }),
        windowsProof: fixtureWindowsProof({ ...proof, sha: actualSha }),
      }),
    )
    const generated = writeFullProof(env)
    assert.equal(generated.sha, actualSha)
    assert.deepEqual(generated.mobileE2e, { requested: false, required: false })
    assert.ok(isCompleteFull(run, generated, actualSha, repository))
    assert.deepEqual(JSON.parse(readFileSync('full-proof.json', 'utf8')), generated)
    const manual = writeFullProof({ ...env, FULL_MOBILE_E2E: 'true' })
    assert.deepEqual(manual.mobileE2e, { requested: true, required: false })
    assert.equal(Object.hasOwn(manual.jobs, 'mobile'), false, 'report 不等待三片，不能伪造其结果')
    assert.throws(() => writeFullProof({ ...env, FULL_SOURCE_SHA: 'b'.repeat(40) }), /实际检出/)
  } finally {
    process.chdir(previous)
    rmSync(temp, { recursive: true, force: true })
  }
})

test('读取真实 ZIP 的唯一证明 JSON，额外文件或无效 JSON 必须拒绝', () => {
  const temp = mkdtempSync(join(tmpdir(), 'litch-proof-zip-'))
  const zip = (...files) => execFileSync('zip', ['-q', '-', ...files], { cwd: temp })
  try {
    writeFileSync(join(temp, 'full-proof.json'), JSON.stringify(proof))
    assert.deepEqual(decodeFullProofArchive(zip('full-proof.json')), proof)
    writeFileSync(join(temp, 'extra.txt'), 'extra')
    assert.throws(() => decodeFullProofArchive(zip('full-proof.json', 'extra.txt')), /内容不符/)
    writeFileSync(join(temp, 'full-proof.json'), 'invalid JSON')
    assert.throws(() => decodeFullProofArchive(zip('full-proof.json')))
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
