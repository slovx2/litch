import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { latestState, stateEnvelope } from './maintenance-state.mjs'
import { nightlyProof, runNightly } from './nightly-run.mjs'

const now = Date.parse('2026-11-03T04:00:00Z')
const sha = 'a'.repeat(40)
const repo = { full_name: 'slovx2/litch' }
const run = {
  id: 123,
  head_sha: sha,
  run_attempt: 1,
  event: 'schedule',
  status: 'completed',
  conclusion: 'success',
  created_at: new Date(now - 60_000).toISOString(),
  path: '.github/workflows/recovery-controller.yml',
  head_branch: 'main',
  repository: repo,
  head_repository: repo,
}
const kind = 'ci-recovery-scan'
function zip(name, value) {
  return execFileSync(
    'python3',
    [
      '-I',
      '-c',
      `
import io, json, sys, zipfile
value = json.load(sys.stdin)
buffer: io.BytesIO = io.BytesIO()
with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr(value["name"], json.dumps(value["value"]))
sys.stdout.buffer.write(buffer.getvalue())
`,
    ],
    { input: JSON.stringify({ name, value }) },
  )
}
function fixture() {
  const state = stateEnvelope(kind, { cursor: 9, receipts: [] }, run, now)
  const bytes = zip(`${kind}.json`, state)
  const machine = {
    state,
    bytes,
    runs: [run],
    job: {
      name: 'recovery',
      status: 'completed',
      run_id: 123,
      head_sha: sha,
      steps: [{ name: '保存公平扫描检查点', conclusion: 'success' }],
    },
    artifact: {
      id: 88,
      name: `${kind}-1`,
      expired: false,
      size_in_bytes: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      workflow_run: { id: 123, head_sha: sha },
    },
  }
  machine.read = (path) => {
    if (path.includes('/workflows/')) return { workflow_runs: machine.runs }
    if (path.includes('/artifacts?')) return { artifacts: [machine.artifact] }
    if (path.includes('/jobs?')) return { jobs: [machine.job] }
    if (path.endsWith('/zip')) return machine.bytes
    throw Error(`unexpected ${path}`)
  }
  return machine
}

test('真实ZIP检查点绑定run/attempt/SHA、artifact digest和上传job，不执行制品代码', () => {
  const machine = fixture()
  assert.equal(latestState(machine.read, kind, { now }).value.cursor, 9)
  for (const corrupt of [
    (m) => {
      m.artifact.digest = `sha256:${'f'.repeat(64)}`
    },
    (m) => {
      m.artifact.workflow_run.id = 1
    },
    (m) => {
      m.job.head_sha = 'b'.repeat(40)
    },
    (m) => {
      m.job.steps[0].conclusion = 'failure'
    },
    (m) => {
      m.state.attempt = 2
      m.bytes = zip(`${kind}.json`, m.state)
      m.artifact.digest = `sha256:${createHash('sha256').update(m.bytes).digest('hex')}`
    },
  ]) {
    const bad = fixture()
    corrupt(bad)
    assert.throws(() => latestState(bad.read, kind, { now }))
  }
})

test('手动、fork、过期制品不当作定时心跳；API失败不能冒充无历史', () => {
  for (const change of [
    { event: 'workflow_dispatch' },
    { head_branch: 'feature' },
    { head_repository: { full_name: 'other/litch' } },
  ]) {
    const m = fixture()
    m.runs = [{ ...run, ...change }]
    assert.equal(latestState(m.read, kind, { now }), null)
  }
  const m = fixture()
  m.artifact.expired = true
  assert.equal(latestState(m.read, kind, { now }), null)
  assert.throws(() =>
    latestState(
      () => {
        throw Error('API')
      },
      kind,
      { now },
    ),
  )
})

test('仅发布者完成即可读检查点，另一维护job仍在运行也不丢游标', () => {
  const m = fixture()
  m.runs = [{ ...run, status: 'in_progress' }]
  assert.equal(latestState(m.read, kind, { now }).value.cursor, 9)
  m.job.status = 'in_progress'
  assert.equal(latestState(m.read, kind, { now }), null)
})

function monitorFixture() {
  const controllerRun = { ...run, event: 'workflow_dispatch', status: 'in_progress' }
  const saves = []
  const writes = []
  const read = (path) => {
    if (path === 'repos/slovx2/litch') return { default_branch: 'main' }
    if (path.endsWith('/actions/runs/123')) return controllerRun
    if (path.endsWith('/workflows/full.yml')) return { state: 'active' }
    if (path.includes('/runs?')) return { workflow_runs: [] }
    throw Error(`unexpected ${path}`)
  }
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'slovx2/litch',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: sha,
    GITHUB_WORKFLOW_REF: 'slovx2/litch/.github/workflows/recovery-controller.yml@refs/heads/main',
    RECOVERY_MODE: 'nightly-observe',
  }
  return {
    env,
    read,
    writes,
    saves,
    write: (...args) => writes.push(args),
    save: (...args) => saves.push(args),
    now,
  }
}

test('夜间手动观察只读，首次接入不伪造漏跑；API失败不发布健康或写通知', () => {
  const m = monitorFixture()
  const result = runNightly(m.env, m)
  assert.equal(result.notification.state, 'observe-only')
  assert.equal(result.report.alerts.length, 0)
  assert.equal(m.writes.length, 0)
  const failed = monitorFixture()
  assert.throws(() =>
    runNightly(failed.env, {
      ...failed,
      read: () => {
        throw Error('API secret')
      },
    }),
  )
  assert.equal(failed.writes.length, 0)
  assert.equal(failed.saves.length, 0)
  assert.throws(() => runNightly({ ...m.env, GITHUB_SHA: 'b'.repeat(40) }, m))
})

test('Full证明缺失只能unknown，来源或digest不符不得报完整', () => {
  assert.equal(
    nightlyProof(() => ({ artifacts: [] }), run),
    'unknown',
  )
  const m = fixture()
  m.artifact.name = 'full-proof-1'
  m.artifact.digest = `sha256:${'f'.repeat(64)}`
  assert.throws(() => nightlyProof(m.read, run))
})
