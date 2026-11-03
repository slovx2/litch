import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parse } from 'yaml'
import { readStateForRun } from './maintenance-state.mjs'
import {
  checkDrillCheckpoint,
  drillEnvelope,
  drillKind,
  drillPath,
  readDrillCheckpoint,
  runScanDrill,
  scanDrill,
} from './recovery-scan-drill.mjs'

const sha = 'b'.repeat(40)
const source = {
  id: 101,
  path: drillPath,
  event: 'workflow_dispatch',
  head_sha: sha,
  head_branch: 'main',
  repository: { full_name: 'slovx2/litch' },
  head_repository: { full_name: 'slovx2/litch' },
  run_attempt: 1,
  created_at: '2026-11-03T01:00:00Z',
  status: 'completed',
  conclusion: 'success',
}
const current = { ...source, id: 102, created_at: '2026-11-03T02:00:00Z', status: 'in_progress' }

function zip(checkpoint) {
  const bad = structuredClone(checkpoint)
  bad.value.state.cursor = -1
  return execFileSync(
    'python3',
    [
      '-I',
      '-c',
      `
import io, json, sys, zipfile
values = json.load(sys.stdin)
buffer: io.BytesIO = io.BytesIO()
with zipfile.ZipFile(buffer, 'w') as archive:
    for name, value in values.items():
        archive.writestr(name, json.dumps(value))
sys.stdout.buffer.write(buffer.getvalue())
`,
    ],
    { input: JSON.stringify({ 'checkpoint.json': checkpoint, 'bad-checkpoint.json': bad }) },
  )
}

function fixture() {
  const checkpoint = drillEnvelope(source, 1, scanDrill())
  const bytes = zip(checkpoint)
  const m = {
    source: structuredClone(source),
    bytes,
    saved: [],
    artifact: {
      id: 201,
      name: `${drillKind}-1`,
      expired: false,
      size_in_bytes: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      workflow_run: { id: source.id, head_sha: sha },
    },
    job: {
      name: 'drill',
      run_id: source.id,
      head_sha: sha,
      conclusion: 'success',
      steps: [{ name: '保存独立演练检查点', conclusion: 'success' }],
    },
  }
  m.read = (path) => {
    if (path.endsWith('/runs/102')) return current
    if (path.endsWith('/runs/101')) return m.source
    if (path.includes('/artifacts?')) return { artifacts: [m.artifact] }
    if (path.includes('/jobs?')) return { jobs: [m.job] }
    if (path.endsWith('/zip')) return m.bytes
    throw Error(`非预期GET ${path}`)
  }
  m.save = (value) => m.saved.push(value)
  return m
}

function env(phase = 'resume') {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'slovx2/litch',
    GITHUB_RUN_ID: '102',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: sha,
    GITHUB_WORKFLOW_REF: `slovx2/litch/${drillPath}@refs/heads/main`,
    DRILL_PHASE: phase,
    DRILL_SOURCE_RUN: phase === 'seed' ? '' : '101',
  }
}

test('真实ZIP承接首轮，超过五来源轮转，成功收据不重复占位', () => {
  const m = fixture()
  const first = runScanDrill(env('seed'), m)
  assert.deepEqual(first.value.selected, [1, 2, 3, 4, 5])
  assert.deepEqual(first.value.remaining, [6, 7, 8])
  const second = runScanDrill(env(), m)
  assert.equal(second.parentRun, 101)
  assert.deepEqual(second.value.selected, [6, 7, 8, 2, 3])
  assert.deepEqual(second.value.remaining, [4, 5])
  assert.equal(second.value.state.cursor, 3)
  assert.deepEqual(
    second.value.state.receipts.find((r) => r.id === 1),
    first.value.state.receipts[0],
  )
  assert.equal(new Set([...first.value.selected, ...second.value.selected]).size, 8)
})

test('digest正确但游标损坏的云端反例拒绝，不保存下一轮', () => {
  const m = fixture()
  assert.throws(() => runScanDrill(env('reject-corrupt'), m), /演练检查点内容损坏/)
  assert.equal(m.saved.length, 0)
})

test('检查点篡改成功收据、身份或轮次都拒绝', () => {
  for (const change of [
    (c) => {
      c.value.state.receipts[0].terminal = false
    },
    (c) => {
      c.sha = 'c'.repeat(40)
    },
    (c) => {
      c.attempt = 2
    },
    (c) => {
      c.runId++
    },
    (c) => {
      c.round = 2
    },
    (c) => {
      c.kind = 'ci-recovery-scan'
    },
  ]) {
    const c = drillEnvelope(source, 1, scanDrill())
    change(c)
    assert.throws(() => checkDrillCheckpoint(c, source))
  }
})

test('错误来源SHA/ref/事件/fork/工作流/attempt/结论拒绝', () => {
  for (const change of [
    { head_sha: 'c'.repeat(40) },
    { head_branch: 'other' },
    { event: 'schedule' },
    { head_repository: { full_name: 'fork/litch' } },
    { path: '.github/workflows/recovery-controller.yml' },
    { run_attempt: 2 },
    { conclusion: 'failure' },
    { status: 'in_progress' },
  ]) {
    const m = fixture()
    Object.assign(m.source, change)
    assert.throws(() => runScanDrill(env(), m))
    assert.equal(m.saved.length, 0)
  }
})

test('缺制品、错误digest或上传者不匹配拒绝，不退回空游标', () => {
  for (const change of [
    (m) => {
      m.artifact.name = 'ci-recovery-scan-1'
    },
    (m) => {
      m.artifact.expired = true
    },
    (m) => {
      m.artifact.digest = `sha256:${'f'.repeat(64)}`
    },
    (m) => {
      m.artifact.workflow_run.id++
    },
    (m) => {
      m.job.head_sha = 'c'.repeat(40)
    },
    (m) => {
      m.job.steps[0].conclusion = 'failure'
    },
  ]) {
    const m = fixture()
    change(m)
    assert.throws(() => readDrillCheckpoint(m.read, 101, current))
  }
})

test('演练检查点不进入正式扫描读取，正式种类也不能被演练接受', () => {
  const m = fixture()
  assert.equal(readStateForRun(m.read, 'ci-recovery-scan', source), null)
  // 即便误放在正式schedule的artifact列表，名字仍不同，不能被正式reader选中。
  assert.equal(
    readStateForRun(m.read, 'ci-recovery-scan', {
      ...source,
      event: 'schedule',
      path: '.github/workflows/recovery-controller.yml',
    }),
    null,
  )
})

test('入口只允许显式三阶段、合法来源及同身份，API失败不写检查点', () => {
  for (const change of [
    { DRILL_PHASE: 'automatic' },
    { DRILL_SOURCE_RUN: '0' },
    { DRILL_SOURCE_RUN: '102' },
    { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_SHA: 'c'.repeat(40) },
    { GITHUB_REPOSITORY: 'fork/litch' },
  ]) {
    const m = fixture()
    assert.throws(() => runScanDrill({ ...env(), ...change }, m))
    assert.equal(m.saved.length, 0)
  }
  const m = fixture()
  assert.throws(() =>
    runScanDrill(env(), {
      ...m,
      read: () => {
        throw Error('API')
      },
    }),
  )
  assert.equal(m.saved.length, 0)
})

test('工作流仅手动Linux、读取权限，失败时不上传；不接正式控制器和预算', () => {
  const workflow = parse(readFileSync(new URL(`../../${drillPath}`, import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'])
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' })
  assert.deepEqual(Object.keys(workflow.jobs), ['drill'])
  const job = workflow.jobs.drill
  assert.equal(job['runs-on'], 'ubuntu-24.04')
  assert.equal(job.permissions, undefined)
  const upload = job.steps.at(-1)
  assert.equal(upload.if, undefined)
  assert.equal(upload.with.name, 'ci-recovery-scan-drill-${{ github.run_attempt }}')
  const code = readFileSync(new URL('./recovery-scan-drill.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(
    code,
    /from ['"].*(?:recovery-run|recovery-controller|recovery-ledger|recovery-write)/,
  )
})
