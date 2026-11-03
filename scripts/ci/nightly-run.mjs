// 定时维护只读观察Full，必要时更新一条跟进issue；与恢复开关独立，不触发测试或发布。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { isCompleteFull, isCompleteReleaseFull } from '../full-proof.mjs'
import { decodeFullProofArchive } from '../full-proof-artifact.mjs'
import { latestState, saveState } from './maintenance-state.mjs'
import { evaluateNightly, fullCron, nightlySlot, nightlySummary } from './nightly-health.mjs'
import { nightlyWriter, notifyNightly } from './nightly-notify.mjs'
import { checkControllerRun } from './recovery-controller.mjs'
import { githubReader, readPages } from './recovery-observe.mjs'

const base = 'repos/slovx2/litch'
export function nightlyProof(read, run) {
  const candidates = readPages(
    read,
    `${base}/actions/runs/${run.id}/artifacts`,
    'artifacts',
  ).filter((a) => a.name === `full-proof-${run.run_attempt}` && !a.expired)
  if (candidates.length !== 1) return 'unknown'
  const artifact = candidates[0]
  if (
    artifact.workflow_run?.id !== run.id ||
    artifact.workflow_run?.head_sha !== run.head_sha ||
    artifact.size_in_bytes > 2 * 1024 * 1024 ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '')
  )
    return 'unknown'
  const bytes = read(`${base}/actions/artifacts/${artifact.id}/zip`, true)
  assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, artifact.digest)
  const proof = decodeFullProofArchive(bytes)
  if (isCompleteFull(run, proof, run.head_sha, 'slovx2/litch')) return 'complete'
  if (isCompleteReleaseFull(run, proof, run.head_sha, 'slovx2/litch')) return 'release-only'
  return 'unknown'
}

export function runNightly(
  env = process.env,
  { read = githubReader(), write = nightlyWriter(), now = Date.now(), save = saveState } = {},
) {
  assert.equal(env.GITHUB_ACTIONS, 'true')
  assert.equal(env.GITHUB_REPOSITORY, 'slovx2/litch')
  assert.match(env.GITHUB_RUN_ID ?? '', /^[1-9]\d*$/)
  assert.equal(env.GITHUB_RUN_ATTEMPT, '1')
  const metadata = read(base)
  const run = read(`${base}/actions/runs/${env.GITHUB_RUN_ID}`)
  const controller = {
    runId: Number(env.GITHUB_RUN_ID),
    sha: env.GITHUB_SHA,
    attempt: 1,
    defaultBranch: metadata.default_branch,
  }
  checkControllerRun(run, controller)
  assert.equal(
    env.GITHUB_WORKFLOW_REF,
    `slovx2/litch/.github/workflows/recovery-controller.yml@refs/heads/${metadata.default_branch}`,
  )
  const manual = run.event === 'workflow_dispatch'
  if (manual) assert.equal(env.RECOVERY_MODE, 'nightly-observe')
  if (run.event === 'workflow_run') {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
    assert.ok(Number.isSafeInteger(event.workflow_run.id))
    const source = read(`${base}/actions/runs/${event.workflow_run.id}`)
    assert.equal(source.path, '.github/workflows/full.yml')
    assert.equal(source.event, 'schedule')
    assert.equal(source.head_branch, metadata.default_branch)
    assert.equal(source.head_repository?.full_name, 'slovx2/litch')
  }
  const yaml = readFileSync(new URL('../../.github/workflows/full.yml', import.meta.url), 'utf8')
  assert.deepEqual(
    parse(yaml).on.schedule,
    [{ cron: fullCron }],
    'Full cron改变，监测触发槽必须同步审核',
  )
  const workflow = read(`${base}/actions/workflows/full.yml`)
  const since = new Date(now - 30 * 24 * 60 * 60_000).toISOString()
  const listed = readPages(
    read,
    `${base}/actions/workflows/full.yml/runs?event=schedule&created=${encodeURIComponent(`>=${since}`)}`,
    'workflow_runs',
  )
    .filter(
      (r) =>
        r.head_branch === metadata.default_branch &&
        r.repository?.full_name === 'slovx2/litch' &&
        r.head_repository?.full_name === 'slovx2/litch',
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  const previous = latestState(read, 'ci-nightly-health', {
    defaultBranch: metadata.default_branch,
    currentRun: run.id,
    now,
  })
  const monitoringSince = previous
    ? Date.parse(previous.value.report.monitoringSince)
    : listed.length
      ? Math.min(...listed.map((r) => nightlySlot(Date.parse(r.created_at))))
      : now
  const runs = listed.map((r) => ({ ...r, coverage: 'unknown', failures: [] }))
  // 查最新结果与最近14个成功夜间的完整证明；没有证明只能报unknown，不能绿灯。
  const latestCompleted = runs.find((source) => source.status === 'completed')
  if (latestCompleted) latestCompleted.coverage = nightlyProof(read, latestCompleted)
  const greenCandidates = runs
    .filter((source) => source.status === 'completed' && source.conclusion === 'success')
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
    .slice(0, 14)
  for (const source of greenCandidates) {
    if (source !== latestCompleted) source.coverage = nightlyProof(read, source)
    if (source.coverage === 'complete') break
  }
  for (const source of runs) {
    if (source === runs[0] || source === latestCompleted) {
      const jobs = readPages(
        read,
        `${base}/actions/runs/${source.id}/attempts/${source.run_attempt}/jobs`,
        'jobs',
      )
      source.acquired = jobs.some((j) => j.runner_name && j.steps?.length)
      source.failures = jobs
        .filter((j) => !['success', 'skipped', null].includes(j.conclusion))
        .map(({ name, conclusion }) => ({ name, conclusion }))
    }
  }
  const report = evaluateNightly({
    runs,
    now,
    monitoringSince,
    workflowState: workflow.state,
    previousHeartbeat: previous?.checkedAt,
  })
  save('ci-nightly-health', { report, notification: 'pending' }, run, now)
  const notification = manual
    ? { state: 'observe-only' }
    : notifyNightly(report, controller, { read, write, now })
  save('ci-nightly-health', { report, notification }, run, now)
  return { report, checkedAt: new Date(now).toISOString(), notification }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = runNightly()
    const summary = nightlySummary(result.report, result.checkedAt)
    console.log(summary)
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  } catch {
    const message =
      '夜间监测未完成：API、证明或通知校验失败；不能报告健康，也不修改已有发版规则。\n'
    console.error(message)
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, message)
    process.exitCode = 1
  }
}
