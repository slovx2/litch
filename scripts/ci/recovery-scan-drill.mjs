// 独立的合成扫描演练：只调用GET与纯选择器，绝不导入恢复执行器或审计写接口。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { readZipText } from './recovery-evidence.mjs'
import { githubReader, readPages } from './recovery-observe.mjs'
import { recordScanned, selectRecoveryBatch } from './recovery-scan.mjs'

export const drillKind = 'ci-recovery-scan-drill'
export const drillPath = '.github/workflows/recovery-scan-drill.yml'
const base = 'repos/slovx2/litch'
// 固定逻辑时钟和合成ID，不随两次dispatch间隔老化，也不冒充仓库真实运行。
const fixtureTime = Date.parse('2026-11-03T00:00:00Z')
export function drillSources() {
  return Array.from({ length: 8 }, (_, i) => ({
    id: i + 1,
    path: '.github/workflows/full.yml',
    head_branch: 'main',
    head_sha: 'a'.repeat(40),
    repository: { full_name: 'slovx2/litch' },
    head_repository: { full_name: 'slovx2/litch' },
    status: 'completed',
    conclusion: i === 0 ? 'success' : 'failure',
    run_attempt: i === 0 ? 2 : 1,
    updated_at: new Date(fixtureTime - 60_000).toISOString(),
  }))
}

export function scanDrill(previous) {
  const batch = selectRecoveryBatch(drillSources(), previous, { now: fixtureTime })
  let state = batch.state
  for (const source of batch.selected) {
    // 只模拟对账结果以验证收据轮转，不据此宣称任何真实恢复成功。
    const result = { state: source.id === 1 ? 'already-resolved' : 'controller-error' }
    state = recordScanned(state, source, result, fixtureTime)
  }
  return { state, selected: batch.selected.map((r) => r.id), remaining: batch.remaining }
}

function checkRun(run) {
  assert.equal(run.path, drillPath)
  assert.equal(run.event, 'workflow_dispatch')
  assert.equal(run.repository?.full_name, 'slovx2/litch')
  assert.equal(run.head_repository?.full_name, 'slovx2/litch')
  assert.equal(run.run_attempt, 1, '演练控制器不能重跑attempt')
  assert.ok(Number.isSafeInteger(run.id) && run.id > 0)
  assert.match(run.head_sha, /^[a-f0-9]{40}$/)
}

export function drillEnvelope(run, round, value, parentRun = null) {
  return {
    schema: 1,
    kind: drillKind,
    runId: run.id,
    sha: run.head_sha,
    attempt: run.run_attempt,
    round,
    parentRun,
    value,
  }
}

export function checkDrillCheckpoint(checkpoint, source) {
  assert.equal(checkpoint.schema, 1)
  assert.equal(checkpoint.kind, drillKind, '拒绝正式或其他种类检查点')
  assert.equal(checkpoint.runId, source.id)
  assert.equal(checkpoint.sha, source.head_sha)
  assert.equal(checkpoint.attempt, 1)
  assert.equal(checkpoint.round, 1, '第二轮只能承接第一轮')
  assert.equal(checkpoint.parentRun, null)
  // 精确重放固定夹具，拒绝被改坏但ZIP digest仍正确的游标或成功收据。
  assert.deepEqual(checkpoint.value, scanDrill(), '演练检查点内容损坏')
  return checkpoint.value.state
}

export function readDrillCheckpoint(read, sourceId, current, badFixture = false) {
  assert.ok(Number.isSafeInteger(sourceId) && sourceId > 0 && sourceId !== current.id)
  const source = read(`${base}/actions/runs/${sourceId}`)
  checkRun(source)
  assert.equal(source.status, 'completed')
  assert.equal(source.conclusion, 'success')
  assert.equal(source.head_sha, current.head_sha, '演练必须冻结同一个SHA')
  assert.equal(source.head_branch, current.head_branch, '演练必须同ref')
  assert.ok(Date.parse(source.created_at) <= Date.parse(current.created_at))
  const artifacts = readPages(
    read,
    `${base}/actions/runs/${sourceId}/artifacts`,
    'artifacts',
  ).filter((a) => a.name === `${drillKind}-1` && !a.expired)
  assert.equal(artifacts.length, 1, '独立演练检查点缺失或重复')
  const artifact = artifacts[0]
  assert.equal(artifact.workflow_run?.id, sourceId)
  assert.equal(artifact.workflow_run?.head_sha, current.head_sha)
  assert.ok(artifact.size_in_bytes <= 2 * 1024 * 1024)
  const jobs = readPages(read, `${base}/actions/runs/${sourceId}/attempts/1/jobs`, 'jobs').filter(
    (j) => j.name === 'drill',
  )
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].run_id, sourceId)
  assert.equal(jobs[0].head_sha, current.head_sha)
  assert.equal(jobs[0].conclusion, 'success')
  assert.ok(
    jobs[0].steps.some((s) => s.name === '保存独立演练检查点' && s.conclusion === 'success'),
  )
  const bytes = read(`${base}/actions/artifacts/${artifact.id}/zip`, true)
  assert.ok(bytes.length <= 2 * 1024 * 1024)
  assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, artifact.digest)
  const name = badFixture ? 'bad-checkpoint.json' : 'checkpoint.json'
  return checkDrillCheckpoint(JSON.parse(readZipText(bytes, name)), source)
}

export function runScanDrill(env, { read = githubReader(), save = saveDrill } = {}) {
  assert.equal(env.GITHUB_ACTIONS, 'true')
  assert.equal(env.GITHUB_REPOSITORY, 'slovx2/litch')
  assert.equal(env.GITHUB_RUN_ATTEMPT, '1')
  assert.match(env.GITHUB_RUN_ID ?? '', /^[1-9]\d*$/)
  const run = read(`${base}/actions/runs/${env.GITHUB_RUN_ID}`)
  checkRun(run)
  assert.equal(run.id, Number(env.GITHUB_RUN_ID))
  assert.equal(run.head_sha, env.GITHUB_SHA)
  assert.equal(env.GITHUB_WORKFLOW_REF, `slovx2/litch/${drillPath}@refs/heads/${run.head_branch}`)
  const phase = env.DRILL_PHASE
  assert.ok(['seed', 'resume', 'reject-corrupt'].includes(phase))
  let previous
  let parentRun = null
  if (phase === 'seed') assert.ok(!env.DRILL_SOURCE_RUN, '首轮不接受来源run')
  else {
    assert.match(env.DRILL_SOURCE_RUN ?? '', /^[1-9]\d*$/)
    parentRun = Number(env.DRILL_SOURCE_RUN)
    previous = readDrillCheckpoint(read, parentRun, run, phase === 'reject-corrupt')
    assert.notEqual(phase, 'reject-corrupt', '坏检查点被错误接受')
  }
  const value = scanDrill(previous)
  const round = phase === 'seed' ? 1 : 2
  assert.deepEqual(value.selected, round === 1 ? [1, 2, 3, 4, 5] : [6, 7, 8, 2, 3])
  assert.deepEqual(value.remaining, round === 1 ? [6, 7, 8] : [4, 5])
  assert.ok(value.state.receipts.find((r) => r.id === 1)?.terminal)
  const checkpoint = drillEnvelope(run, round, value, parentRun)
  save(checkpoint)
  return checkpoint
}

function saveDrill(checkpoint) {
  mkdirSync('.artifacts/scan-drill', { recursive: true })
  writeFileSync('.artifacts/scan-drill/checkpoint.json', `${JSON.stringify(checkpoint)}\n`)
  if (checkpoint.round === 1) {
    const bad = structuredClone(checkpoint)
    bad.value.state.cursor = -1
    writeFileSync('.artifacts/scan-drill/bad-checkpoint.json', `${JSON.stringify(bad)}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let summary
  try {
    const result = runScanDrill(process.env)
    summary = `## 只读扫描演练\n仅使用8个合成来源，无恢复和审计写入。\n轮次：${result.round}；来源run：${result.parentRun ?? '无'}\n选中：${result.value.selected.join(', ')}；剩余：${result.value.remaining.join(', ')}\n模拟成功收据1保留；检查点与正式预算隔离。\n`
  } catch (error) {
    const reason = error.message?.startsWith('演练检查点内容损坏')
      ? '演练检查点内容损坏'
      : '来源或检查点校验未通过'
    summary = `只读扫描演练拒绝：${reason}；没有恢复、审计写入或输出下一轮检查点。\n`
    process.exitCode = 1
  }
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
}
