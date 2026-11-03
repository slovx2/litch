// 恢复控制器：一次reservation、一次API；未知结果只读对账，不重发POST。
import assert from 'node:assert/strict'
import { loadLedger, persistRecord } from './recovery-ledger.mjs'
import { readPages } from './recovery-observe.mjs'
import { controllerPlan, executionHash } from './recovery-plan.mjs'
import { evidenceHash } from './recovery-policy.mjs'

const base = 'repos/slovx2/litch'
const controllerPath = '.github/workflows/recovery-controller.yml'

export function checkControllerRun(run, context) {
  assert.equal(run.repository?.full_name, 'slovx2/litch')
  assert.equal(run.head_repository?.full_name, 'slovx2/litch')
  assert.equal(run.path, controllerPath)
  assert.equal(run.id, context.runId)
  assert.equal(run.head_sha, context.sha)
  assert.equal(run.run_attempt, 1, '控制器不允许被重跑以绕过预算')
  assert.equal(context.attempt, 1)
  assert.ok(['workflow_run', 'schedule', 'workflow_dispatch'].includes(run.event))
  if (context.rehearsal) {
    assert.equal(run.event, 'workflow_dispatch')
    assert.equal(run.head_branch, 'ci/recovery-nightly')
  } else {
    assert.equal(run.head_branch, context.defaultBranch)
  }
}

function artifacts(read, runId) {
  return readPages(read, `${base}/actions/runs/${runId}/artifacts`, 'artifacts')
    .map(({ id, name, digest, expired }) => ({ id, name, digest, expired }))
    .sort((a, b) => a.id - b.id)
}

export function verifyRecoveryOutcome(plan, jobs, currentArtifacts) {
  const byName = new Map(jobs.map((job) => [job.name, job]))
  assert.equal(byName.size, jobs.length, '恢复后的逻辑job重复')
  const allowed = new Set(plan.closure.map((node) => node.name))
  const preserved = new Set(plan.preservedJobs.map((job) => job.name))
  for (const prior of plan.preservedJobs) {
    const job = byName.get(prior.name)
    assert.equal(job?.conclusion, 'success', '原成功片状态改变')
    assert.equal(executionHash(job), prior.executionHash, '原成功片被重新执行')
  }
  for (const job of jobs) {
    assert.equal(job.run_id, plan.runId, '恢复job源run')
    assert.equal(job.head_sha, plan.sha, '恢复job源码')
    assert.ok([1, 2].includes(job.run_attempt), '恢复job attempt')
    if (job.conclusion !== 'skipped')
      assert.ok(allowed.has(job.name) || preserved.has(job.name), 'API重跑范围超出计划')
  }
  for (const prior of plan.artifacts) {
    const current = currentArtifacts.find((item) => item.id === prior.id)
    assert.ok(current && !current.expired, '原产物丢失或被替换')
    assert.equal(current.name, prior.name)
    assert.equal(current.digest, prior.digest, '原产物hash改变')
  }
  return true
}

function reconcile(ledger, run, services) {
  const { read, write, controller, now } = services
  const plan = ledger.plan
  const append = (type, details) =>
    persistRecord({ read, write, controller, plan, type, details, now: now() })
  if (ledger.state === 'resolved') return { state: 'already-resolved', runId: run.id }
  assert.equal(run.head_sha, plan.sha)
  assert.ok(run.run_attempt === 1 || run.run_attempt === 2, '其他人工attempt介入，停止自动对账')
  if (run.run_attempt === 1) {
    if (ledger.state === 'reserved')
      ledger = append('uncertain', { reason: 'previous-call-not-confirmed' })
    if (now() >= Date.parse(plan.expiresAt))
      append('resolved', { reservation: ledger.reservation, conclusion: 'not-observed' })
    return { state: 'reserved-awaiting-api-result', runId: run.id }
  }
  if (['reserved', 'uncertain'].includes(ledger.state))
    ledger = append('dispatched', { reservation: ledger.reservation, attempt: 2 })
  if (run.status !== 'completed') return { state: 'recovery-running', runId: run.id }
  const jobs = readPages(read, `${base}/actions/runs/${run.id}/attempts/2/jobs`, 'jobs')
  let outcomeVerified = false
  try {
    outcomeVerified = verifyRecoveryOutcome(plan, jobs, artifacts(read, run.id))
  } catch {
    // 永远保留原reservation。范围/产物不符是验收失败，不会再重跑去碰绿。
  }
  append('resolved', {
    reservation: ledger.reservation,
    conclusion: outcomeVerified && run.conclusion === 'success' ? 'success' : 'failure',
    actualConclusion: run.conclusion,
    outcomeVerified,
  })
  return {
    state: outcomeVerified ? 'recovery-completed' : 'recovery-verification-failed',
    runId: run.id,
    conclusion: run.conclusion,
  }
}

export function recoverRun(runId, services) {
  const {
    read,
    write,
    controller,
    observe,
    readWorkflow,
    now = Date.now,
    enabled = false,
  } = services
  const path = `${base}/actions/runs/${runId}`
  const run = read(path)
  assert.equal(run.id, Number(runId))
  assert.equal(run.repository?.full_name, 'slovx2/litch')
  if (!enabled) return { state: 'observe-only', report: observe(runId).plan }
  const source = { runId: run.id, sha: run.head_sha, createdAt: run.created_at }
  let ledger = loadLedger(read, source)
  if (ledger?.reserved) return reconcile(ledger, run, { ...services, now })
  const observed = observe(runId)
  if (!observed.stable) return { state: 'blocked', reason: 'unstable-observation' }
  const plan = controllerPlan(observed.snapshot, readWorkflow, {
    now: now(),
    rehearsal: controller.rehearsal,
  })
  if (!['eligible', 'deferred'].includes(plan.decision)) {
    if (ledger && ledger.last.details.reason !== plan.reason)
      persistRecord({
        read,
        write,
        controller,
        plan,
        type: 'observation',
        details: { decision: plan.decision, reason: plan.reason },
        now: now(),
      })
    return { state: plan.decision, reason: plan.reason, report: plan }
  }
  // 缺失账本不能被当成新预算：已有控制器在源run结束后处理过却没有可靠记录时停下。
  if (!ledger) {
    const since = new Date(Date.parse(run.updated_at) - 10 * 60_000).toISOString()
    const history = readPages(
      read,
      `${base}/actions/workflows/recovery-controller.yml/runs?created=${encodeURIComponent(`>=${since}`)}`,
      'workflow_runs',
    )
    if (
      history.some(
        (item) =>
          item.id !== controller.runId &&
          Date.parse(item.updated_at) >= Date.parse(run.updated_at) &&
          !/^CI recovery \d+ observe$/.test(item.display_title ?? '') &&
          (item.display_title === `CI recovery ${run.id} fixture-recover` ||
            item.display_title === `CI recovery ${run.id} automatic` ||
            !/^CI recovery \d+ (?:fixture-recover|automatic)$/.test(item.display_title ?? '')),
      )
    )
      return { state: 'blocked', reason: 'ledger-missing-after-prior-controller' }
  }
  if (plan.decision === 'deferred') {
    if (!ledger || ledger.last.details.reason !== plan.reason)
      persistRecord({
        read,
        write,
        controller,
        plan,
        type: 'observation',
        details: { reason: plan.reason },
        now: now(),
      })
    return { state: 'deferred', runId: run.id, reason: plan.reason }
  }
  plan.artifacts = artifacts(read, run.id)
  assert.ok(
    plan.artifacts.every((item) => !item.expired && /^sha256:[a-f0-9]{64}$/.test(item.digest)),
    '现有产物摘要缺失',
  )
  ledger = persistRecord({
    read,
    write,
    controller,
    plan,
    type: 'reservation',
    details: { request: plan.request },
    now: now(),
  })
  const abort = (reason) => {
    persistRecord({
      read,
      write,
      controller,
      plan,
      type: 'aborted',
      details: { reservation: ledger.reservation, reason },
      now: now(),
    })
    return { state: 'aborted', reason, runId: run.id }
  }
  const again = observe(runId)
  if (!again.stable) return abort('source-changed-after-reservation')
  const checked = controllerPlan(again.snapshot, readWorkflow, {
    now: now(),
    rehearsal: controller.rehearsal,
  })
  checked.artifacts = artifacts(read, run.id)
  if (evidenceHash(checked) !== evidenceHash(plan)) return abort('plan-changed-after-reservation')
  const fresh = read(path)
  if (fresh.run_attempt !== 1 || fresh.status !== 'completed' || fresh.head_sha !== plan.sha)
    return abort('source-changed-before-api')
  const endpoint =
    plan.request.kind === 'job'
      ? `${base}/actions/jobs/${plan.request.jobId}/rerun`
      : `${path}/rerun-failed-jobs`
  try {
    write(endpoint, {})
  } catch {
    persistRecord({
      read,
      write,
      controller,
      plan,
      type: 'uncertain',
      details: { reservation: ledger.reservation, reason: 'api-response-not-confirmed' },
      now: now(),
    })
    return { state: 'api-result-uncertain', runId: run.id }
  }
  // API接受不等于实际生成了下一attempt；记录实际观察值，后续completed/reconcile接力。
  const latest = read(path)
  if (latest.run_attempt === 2 && latest.head_sha === plan.sha)
    return reconcile(ledger, latest, { ...services, now })
  persistRecord({
    read,
    write,
    controller,
    plan,
    type: 'uncertain',
    details: { reservation: ledger.reservation, reason: 'api-accepted-awaiting-attempt' },
    now: now(),
  })
  return { state: 'api-accepted-awaiting-attempt', runId: run.id }
}
