import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  capacityMessage,
  checkCapacity,
  checkEnvelope,
  checkHistory,
  checkSource,
} from './local-mac-policy.mjs'
import { nativeCliVersions, nativePlan } from './mac-native-plan.mjs'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const pem = publicKey.export({ type: 'spki', format: 'pem' })
const context = { repository: 'slovx2/litch', runId: 42, sha: 'a'.repeat(40) }
const selected = ['browser']
const source = { ...context, attempt: 1, jobId: 20 }
const job = {
  id: 20,
  run_attempt: 1,
  name: 'gate / tests / native / checks',
  status: 'completed',
  conclusion: 'cancelled',
  runner_id: 0,
  runner_name: '',
  steps: [],
  annotations: [{ annotation_level: 'failure', message: capacityMessage }],
}
const basePayload = () => ({
  schema: 1,
  source,
  environment: {
    platform: 'darwin',
    arch: 'arm64',
    node: 'v24.21.0',
    go: 'go version go1.26.10 darwin/arm64',
    os: '15.0',
    xcode: 'Xcode 26.0',
    sdk: '26.0',
  },
  startedAt: '2026-11-05T00:00:00Z',
  completedAt: '2026-11-05T00:01:00Z',
  proof: {
    schema: 1,
    ...context,
    attempt: 1,
    workflowSha: context.sha,
    platform: 'darwin',
    arch: 'arm64',
    plan: nativePlan(selected),
    clis: nativeCliVersions(selected),
    complete: true,
    results: [{ id: 'browser', code: 0, signal: null }],
  },
})
function envelope(payload = basePayload(), key = privateKey) {
  const text = JSON.stringify(payload)
  return {
    schema: 1,
    payload: text,
    signature: sign(null, Buffer.from(text), key).toString('base64'),
  }
}
function accepted(payload = basePayload(), history = [job]) {
  const proof = checkEnvelope(envelope(payload), pem, context, selected)
  checkHistory(history, proof.source, job.name)
  return proof
}
test('容量失败且完整同SHA签名证明有效才通过', () => assert.equal(accepted().proof.complete, true))
test('同run的新attempt可以核验旧容量失败，但不能拿别的run或job凑证明', () => {
  assert.ok(
    accepted(basePayload(), [
      job,
      { ...job, id: 21, run_attempt: 2, status: 'in_progress', conclusion: null },
    ]),
  )
  for (const sourceChange of [
    { runId: 43 },
    { sha: 'b'.repeat(40) },
    { jobId: 21 },
    { attempt: 2 },
  ]) {
    const p = basePayload()
    p.source = { ...source, ...sourceChange }
    assert.throws(() => accepted(p))
  }
})
test('SHA、检查集合、命令、结果、环境、CLI任一不符都拒绝', () => {
  for (const change of [
    (p) => {
      p.proof.sha = 'b'.repeat(40)
    },
    (p) => {
      p.proof.results = []
    },
    (p) => {
      p.proof.plan.checks = []
    },
    (p) => {
      p.proof.plan.checks[0].command = ['true']
    },
    (p) => {
      p.proof.results[0].code = 1
    },
    (p) => {
      p.proof.results[0].signal = 'SIGTERM'
    },
    (p) => {
      p.proof.complete = false
    },
    (p) => {
      p.environment.node = 'v22.0.0'
    },
    (p) => {
      p.proof.clis.push({ id: 'CLAUDE', version: 'wrong' })
    },
  ]) {
    const p = basePayload()
    change(p)
    assert.throws(() => accepted(p))
  }
})
test('篡改载荷、换签名人和缺少签名不能伪造本机证明', () => {
  const e = envelope()
  e.payload += ' '
  assert.throws(() => checkEnvelope(e, pem, context, selected))
  assert.throws(() =>
    checkEnvelope(
      envelope(basePayload(), generateKeyPairSync('ed25519').privateKey),
      pem,
      context,
      selected,
    ),
  )
  assert.throws(() => checkEnvelope({ ...envelope(), signature: '' }, pem, context, selected))
})
test('真实失败、用户取消、未知标注或混合故障不能覆盖', () => {
  for (const altered of [
    { ...job, runner_id: 9 },
    { ...job, steps: [{ conclusion: 'failure' }] },
    { ...job, annotations: [] },
    { ...job, conclusion: 'timed_out' },
    {
      ...job,
      annotations: [...job.annotations, { annotation_level: 'failure', message: 'product failed' }],
    },
  ])
    assert.throws(() => checkCapacity(altered, altered.annotations))
  assert.throws(() => accepted(basePayload(), [{ ...job, id: 19, runner_id: 9 }, job]))
})
test('来源必须是本仓库同SHA的受保护main/release分支，拒绝fork及PR', () => {
  const run = {
    id: 42,
    repository: { full_name: context.repository },
    head_repository: { full_name: context.repository },
    head_sha: context.sha,
    head_branch: 'main',
    path: '.github/workflows/release.yml',
    event: 'workflow_dispatch',
  }
  checkSource(run, context, { protected: true })
  for (const changed of [
    { event: 'pull_request' },
    { event: 'pull_request_target' },
    { head_branch: 'feature/test' },
    { head_repository: { full_name: 'fork/litch' } },
    { head_sha: 'b'.repeat(40) },
  ])
    assert.throws(() => checkSource({ ...run, ...changed }, context, { protected: true }))
  assert.throws(() => checkSource(run, context, { protected: false }))
})
test('只收证明工作流有环境及受保护分支限制；签名出包不接受本地兜底', () => {
  const ingress = readFileSync('.github/workflows/local-mac-proof.yml', 'utf8')
  assert.match(ingress, /environment: local-mac-fallback/)
  assert.match(ingress, /if: github.ref_protected/)
  assert.doesNotMatch(ingress, /pull_request|self-hosted/)
  const release = readFileSync('.github/workflows/release.yml', 'utf8')
  const signing = release.split('  desktop-macos:')[1].split('  desktop-windows:')[0]
  assert.doesNotMatch(signing, /local-mac|fallback/)
  assert.match(
    readFileSync('scripts/ci/local-mac-fallback.mjs', 'utf8'),
    /finally \{\s+rmSync\(temp/,
  )
})

test('远端元数据逐项绑定GitHub Actions check，读取全部attempt并返回route入口', async () => {
  const { sourceState } = await import('./local-mac-remote.mjs')
  const run = {
    id: 42,
    repository: { full_name: context.repository },
    head_repository: { full_name: context.repository },
    head_sha: context.sha,
    head_branch: 'main',
    path: '.github/workflows/release.yml',
    event: 'workflow_dispatch',
  }
  const route = {
    id: 18,
    name: job.name.replace(/checks$/, 'route'),
    run_attempt: 1,
    conclusion: 'success',
  }
  let app = 'github-actions'
  let jobSha = context.sha
  const calls = []
  const options = {
    read(path) {
      calls.push(path)
      if (path.includes('/branches/')) return { protected: true }
      if (path.includes('/check-runs/'))
        return { id: 20, head_sha: context.sha, app: { slug: app } }
      return run
    },
    list(path) {
      calls.push(path)
      return path.includes('/annotations')
        ? job.annotations
        : [{ ...job, run_id: 42, head_sha: jobSha }, route]
    },
  }
  assert.equal(sourceState(context, options).routeId, 18)
  assert.ok(calls.some((path) => path.includes('filter=all')))
  app = 'custom-check-app'
  assert.throws(() => sourceState(context, options), /GitHub Actions/)
  app = 'github-actions'
  jobSha = 'b'.repeat(40)
  assert.throws(() => sourceState(context, options))
})
