// Actions检查点只用于轮转和展示，永远不能代替恢复reservation或发版证明。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readZipText } from './recovery-evidence.mjs'
import { readPages } from './recovery-observe.mjs'

export const repository = 'slovx2/litch'
export const maintenancePath = '.github/workflows/recovery-controller.yml'
const base = `repos/${repository}`
const kinds = {
  'ci-recovery-scan': { job: 'recovery', step: '保存公平扫描检查点', events: ['schedule'] },
  'ci-nightly-health': { job: 'nightly', step: '保存夜间监测心跳', events: ['schedule'] },
}

export function stateEnvelope(kind, value, run, now = Date.now()) {
  assert.ok(Object.hasOwn(kinds, kind))
  return {
    schema: 1,
    kind,
    repository,
    runId: run.id,
    sha: run.head_sha,
    attempt: run.run_attempt,
    event: run.event,
    checkedAt: new Date(now).toISOString(),
    value,
  }
}

export function checkState(state, kind, run, now = Date.now()) {
  assert.equal(state.schema, 1)
  assert.equal(state.kind, kind)
  assert.equal(state.repository, repository)
  assert.equal(state.runId, run.id)
  assert.equal(state.sha, run.head_sha)
  assert.equal(state.attempt, run.run_attempt)
  assert.equal(state.event, run.event)
  assert.ok(Date.parse(state.checkedAt) >= Date.parse(run.created_at))
  assert.ok(Date.parse(state.checkedAt) <= now + 30_000)
  assert.ok(state.value && typeof state.value === 'object')
  return state
}

export function latestState(
  read,
  kind,
  { defaultBranch = 'main', currentRun, now = Date.now() } = {},
) {
  const contract = kinds[kind]
  assert.ok(contract)
  // 有界历史；缺检查点明确返回unknown，由调用方报告，不能拿别人的artifact顶替。
  const runs = read(
    `${base}/actions/workflows/recovery-controller.yml/runs?event=schedule&per_page=30`,
  ).workflow_runs
  assert.ok(Array.isArray(runs))
  for (const run of runs) {
    if (run.id === currentRun) continue
    const state = readStateForRun(read, kind, run, { defaultBranch, now })
    if (state) return state
  }
  return null
}

export function readStateForRun(
  read,
  kind,
  run,
  { defaultBranch = 'main', now = Date.now() } = {},
) {
  const contract = kinds[kind]
  assert.ok(contract)
  if (!['completed', 'in_progress'].includes(run.status) || !contract.events.includes(run.event))
    return null
  if (
    run.path !== maintenancePath ||
    run.head_branch !== defaultBranch ||
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository
  )
    return null
  const artifacts = readPages(read, `${base}/actions/runs/${run.id}/artifacts`, 'artifacts').filter(
    (a) => a.name === `${kind}-${run.run_attempt}` && !a.expired,
  )
  if (!artifacts.length) return null
  assert.equal(artifacts.length, 1, '检查点制品不唯一')
  const artifact = artifacts[0]
  assert.equal(artifact.workflow_run?.id, run.id)
  assert.equal(artifact.workflow_run?.head_sha, run.head_sha)
  assert.ok(artifact.size_in_bytes <= 2 * 1024 * 1024)
  assert.match(artifact.digest ?? '', /^sha256:[a-f0-9]{64}$/)
  const jobs = readPages(
    read,
    `${base}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
    'jobs',
  ).filter((job) => job.name === contract.job)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].run_id, run.id)
  assert.equal(jobs[0].head_sha, run.head_sha)
  // 维护job分别串行；仅信已完成发布者，不必等同run的另一个维护job。
  if (jobs[0].status !== 'completed') return null
  assert.ok(
    jobs[0].steps.some((step) => step.name === contract.step && step.conclusion === 'success'),
  )
  const bytes = read(`${base}/actions/artifacts/${artifact.id}/zip`, true)
  assert.ok(bytes.length <= 2 * 1024 * 1024)
  assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, artifact.digest)
  return checkState(JSON.parse(readZipText(bytes, `${kind}.json`)), kind, run, now)
}

export function saveState(kind, value, run, now = Date.now()) {
  const state = stateEnvelope(kind, value, run, now)
  mkdirSync('.artifacts', { recursive: true })
  writeFileSync(`.artifacts/${kind}.json`, `${JSON.stringify(state)}\n`)
  return state
}
