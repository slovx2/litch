import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parse } from 'yaml'
import { reconcileRecoverySources } from './recovery-run.mjs'
import { recordScanned, selectRecoveryBatch } from './recovery-scan.mjs'

const now = Date.parse('2026-11-03T04:00:00Z')
function run(id, changes = {}) {
  return {
    id,
    path: '.github/workflows/full.yml',
    head_branch: 'main',
    head_sha: 'a'.repeat(40),
    repository: { full_name: 'slovx2/litch' },
    head_repository: { full_name: 'slovx2/litch' },
    status: 'completed',
    conclusion: 'failure',
    run_attempt: 1,
    updated_at: new Date(now - 60_000).toISOString(),
    ...changes,
  }
}

test('每轮五个按游标公平轮转；失败/新来源不让旧来源饿死', () => {
  let state
  const seen = []
  const runs = Array.from({ length: 12 }, (_, i) => run(i + 1))
  for (let round = 0; round < 3; round++) {
    const batch = selectRecoveryBatch([...runs, run(100 + round)], state, { now })
    assert.equal(batch.selected.length, 5)
    state = batch.state
    for (const source of batch.selected) {
      seen.push(source.id)
      state = recordScanned(state, source, { state: 'controller-error' }, now)
    }
  }
  assert.ok(runs.every((source) => seen.includes(source.id)))
})

test('已resolved且未变来源不再占五个名额；新的attempt仍须重新对账', () => {
  const source = run(1)
  const state = recordScanned(
    { cursor: 0, receipts: [] },
    source,
    { state: 'already-resolved' },
    now,
  )
  assert.equal(selectRecoveryBatch([source, run(2)], state, { now }).selected[0].id, 2)
  assert.ok(
    selectRecoveryBatch([{ ...source, run_attempt: 2 }, run(2)], state, { now }).selected.some(
      (r) => r.id === 1,
    ),
  )
})

test('deferred过两小时仍做一次到期判断；检查点不延长授权窗口', () => {
  const source = run(1)
  const state = recordScanned({ cursor: 0, receipts: [] }, source, { state: 'deferred' }, now)
  const later = now + 3 * 3600_000
  assert.equal(selectRecoveryBatch([source], state, { now: later }).selected.length, 1)
  const ended = recordScanned(
    state,
    source,
    { state: 'blocked', reason: 'recovery-window-expired' },
    later,
  )
  assert.equal(selectRecoveryBatch([source], ended, { now: later }).selected.length, 0)
  assert.equal(selectRecoveryBatch([source], undefined, { now: later }).selected.length, 0)
})

test('临时取证blocked不能当永久终态；分支/fork/运行中不进入补偿', () => {
  const state = recordScanned(
    { cursor: 0, receipts: [] },
    run(1),
    { state: 'blocked', reason: 'unstable-observation' },
    now,
  )
  assert.equal(selectRecoveryBatch([run(1)], state, { now }).selected.length, 1)
  for (const change of [
    { head_branch: 'fork' },
    { head_repository: { full_name: 'other/litch' } },
    { status: 'in_progress' },
  ])
    assert.equal(selectRecoveryBatch([run(2, change)], state, { now }).selected.length, 0)
})

test('一片异常仍保存游标并继续；剩余来源明确列出，不假装已处理', () => {
  let saved
  const calls = []
  const result = reconcileRecoverySources(
    Array.from({ length: 8 }, (_, i) => run(i + 1)),
    undefined,
    {},
    {
      now,
      save: (state) => {
        saved = state
      },
      recover: (id) => {
        calls.push(id)
        if (id === 1) throw Error('secret')
        return { state: 'already-resolved', runId: id }
      },
    },
  )
  assert.deepEqual(calls, [1, 2, 3, 4, 5])
  assert.equal(saved.cursor, 5)
  assert.deepEqual(result.at(-1).remaining, [6, 7, 8])
  assert.ok(!JSON.stringify(result).includes('secret'))
})

test('维护只有现有一份15分钟cron，关恢复时nightly仍跑；手动观察无写权限', () => {
  const workflow = parse(
    readFileSync(
      new URL('../../.github/workflows/recovery-controller.yml', import.meta.url),
      'utf8',
    ),
  )
  assert.deepEqual(workflow.on.schedule, [{ cron: '8,23,38,53 * * * *' }])
  assert.match(workflow.jobs.recovery.if, /LITCH_CI_RECOVERY_ENABLED == 'true'/)
  assert.ok(!workflow.jobs.nightly.if.includes('LITCH_CI_RECOVERY_ENABLED'))
  assert.equal(workflow.jobs.nightly['runs-on'], 'ubuntu-24.04')
  assert.equal(workflow.jobs.nightly.permissions.actions, 'read')
  assert.equal(workflow.concurrency, undefined)
  assert.equal(workflow.jobs.recovery.concurrency.group, 'ci-infrastructure-recovery-controller')
  assert.equal(workflow.jobs.nightly.concurrency.group, 'ci-nightly-health-monitor')
  assert.equal(workflow.jobs['nightly-observe'].permissions.issues, undefined)
  assert.equal(workflow.jobs['nightly-observe'].permissions.actions, 'read')
  for (const file of ['ci', 'release'])
    assert.match(
      readFileSync(new URL(`../../.github/workflows/${file}.yml`, import.meta.url), 'utf8'),
      /node scripts\/ci\/nightly-status.mjs/,
    )
})
