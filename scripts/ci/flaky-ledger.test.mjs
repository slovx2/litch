import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadRun, prepareRecord, saveRecord } from '../ci-flaky.mjs'
import {
  checkoutSha,
  counts,
  recordEvent,
  repository,
  summary,
  testResults,
  validateLedger,
  workflow,
} from './flaky-ledger.mjs'

const sha = 'a'.repeat(40)
const ledger = () => ({ version: 1, repository, workflow, cases: [] })
const event = (runId = 1, attempt = 1) => ({
  runId,
  attempt,
  jobId: runId * 100 + attempt,
  sha,
  date: '2026-11-07T00:00:00Z',
  trigger: 'schedule',
  url: 'https://github.com/slovx2/litch/actions/runs/1/job/101',
  failure: '断言失败',
  evidence: {
    kind: 'local-rerun',
    reference: 'https://github.com/slovx2/litch/issues/35',
    note: '维护者记录隔离同用例复跑三次通过',
  },
})
const entry = (record = event(), job = 'native / checks', name = 'client:projections') => ({
  job,
  test: name,
  event: record,
})
const checkout = `[command]/usr/bin/git log -1 --format=%H\n${sha}\n`

test('三个独立 run 提示审批，同 run 的重跑、重复登记不增加次数', () => {
  let data = ledger()
  for (const [run, attempt] of [
    [1, 1],
    [1, 1],
    [1, 2],
    [2, 1],
    [3, 1],
  ]) {
    data = recordEvent(data, entry(event(run, attempt)))
  }
  assert.equal(data.cases[0].events.length, 4)
  assert.equal(counts(data.cases[0]).count, 3)
  assert.match(summary(data), /需要用户审批是否移出 Full/)
  assert.equal(data.cases[0].status, 'active')
})

test('两个 run 提前提示；不同作业或用例独立计数', () => {
  let data = recordEvent(ledger(), entry())
  data = recordEvent(data, entry(event(2)))
  data = recordEvent(data, entry(event(3), 'gate / unit'))
  data = recordEvent(data, entry(event(4), 'native / checks', 'client:adapter'))
  assert.match(summary(data), /接近 3 次审批门槛/)
  assert.deepEqual(data.cases.map((item) => counts(item).count).sort(), [1, 1, 2])
})

test('待核实不计数，补通过依据更新同一条记录', () => {
  const pending = { ...event(), evidence: { kind: 'pending', note: '只有红灯，无通过证据' } }
  const data = recordEvent(ledger(), entry(pending))
  assert.deepEqual(counts(data.cases[0]), { count: 0, pending: 1 })
  const next = recordEvent(data, entry())
  assert.deepEqual(counts(next.cases[0]), { count: 1, pending: 0 })
  assert.equal(next.cases[0].events.length, 1)
})

test('已排除手机记录保留但永不计数；普通 record 不能解除排除', () => {
  const data = recordEvent(ledger(), entry())
  data.cases[0].status = 'excluded'
  data.cases[0].exclusion = {
    reason: '用户明确保持手动按需',
    reference: 'docs/reference/ci-flaky.md',
  }
  const next = recordEvent(data, entry(event(2)))
  assert.equal(counts(next.cases[0]).count, 0)
  assert.match(summary(next), /已排除，不计数/)
})

test('损坏账本、无依据的确认、不同 SHA 的通过证明与重复事件被拒绝', () => {
  assert.throws(() => validateLedger({ ...ledger(), version: 2 }))
  assert.throws(() =>
    recordEvent(ledger(), entry({ ...event(), evidence: { kind: 'local-rerun', note: '通过' } })),
  )
  assert.throws(() =>
    recordEvent(
      ledger(),
      entry({
        ...event(),
        evidence: {
          kind: 'same-sha-pass',
          note: '通过',
          reference: 'url',
          sha: 'b'.repeat(40),
          runId: 2,
          attempt: 1,
          jobId: 201,
        },
      }),
    ),
  )
  const data = recordEvent(ledger(), entry())
  assert.throws(() => recordEvent(data, entry({ ...event(), sha: 'b'.repeat(40) })))
  data.cases[0].events.push(event())
  assert.throws(() => validateLedger(data))
})

test('新增手机 E2E 用例自动沿用已排除决定，手机构建仍单独计数', () => {
  let data = recordEvent(ledger(), entry(event(), 'mobile (2)', 'fixture/launch'))
  data = recordEvent(data, entry(event(), 'mobile-build', 'APK'))
  assert.equal(counts(data.cases.find((item) => item.job === 'mobile (2)')).count, 0)
  assert.equal(counts(data.cases.find((item) => item.job === 'mobile-build')).count, 1)
  data.cases.find((item) => item.job === 'mobile (2)').status = 'active'
  assert.throws(() => validateLedger(data), /手机模拟器 E2E 已排除/)
})

test('提取 Mac/Client 汇总、Node spec/TAP、Go 用例，去掉颜色和重复失败摘要', () => {
  const log = [
    '2026-11-07T00:00:00.123Z MAC_CHECK_RESULT {"id":"client:projections","code":1}',
    'CLIENT_CHECK_RESULT {"name":"remote:service","code":1}',
    '\x1b[31m✖ 子代理 (23330.159132ms)\x1b[0m',
    '✖ failing tests:',
    '✖ 子代理 (23330.159132ms)',
    'not ok 2 - 深层断言',
    'ok 3 - 跳过 # SKIP',
    'not ok 4 - 待实现 # TODO',
    '--- FAIL: TestStop (0.02s)',
    '✔ 成功 (2.4ms)',
    'MAC_CHECK_RESULT {"id":"killed","code":null,"signal":"SIGTERM"}',
  ].join('\n')
  assert.deepEqual(
    testResults(log)
      .filter((result) => !result.passed)
      .map((result) => result.name),
    ['client:projections', 'client:remote:service', '子代理', '深层断言', 'TestStop', 'killed'],
  )
  assert.equal(testResults('✖ 重试 (1ms)\n✔ 重试 (1ms)')[0].passed, false)
})

test('检出 SHA 不能被调度 SHA 或多份 checkout 猜测替代', () => {
  assert.equal(
    checkoutSha(`2026-11-07T00:00:00Z ${checkout.replace('\n', '\n2026-11-07T00:00:00Z ')}`),
    sha,
  )
  assert.throws(() => checkoutSha(`HEAD_SHA: ${sha}`))
  assert.throws(() => checkoutSha(checkout + checkout.replaceAll(sha, 'b'.repeat(40))))
})

function fakeApi({ passSha = sha, passLog = '✔ 测试 (1ms)', path = workflow, pages = false } = {}) {
  return (endpoint) => {
    const run = /actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(endpoint)
    if (run)
      return {
        id: Number(run[1]),
        run_attempt: Number(run[2]),
        path,
        event: 'schedule',
        repository: { full_name: repository },
      }
    const jobs = /actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?per_page=100&page=(\d+)/.exec(
      endpoint,
    )
    if (jobs)
      return {
        total_count: pages ? 2 : 1,
        jobs: [
          {
            id: Number(jobs[1]) * 100 + Number(jobs[2]),
            name: jobs[3] === '1' ? 'native / checks' : 'another job',
            status: 'completed',
            conclusion: 'failure',
            started_at: '2026-11-07T00:00:00Z',
            html_url: 'https://github.com/slovx2/litch/actions/runs/1/job/101',
          },
        ],
      }
    if (endpoint === 'actions/jobs/101/logs') return `${checkout}✖ 测试 (1ms)`
    if (endpoint === 'actions/jobs/201/logs') return checkout.replaceAll(sha, passSha) + passLog
    throw new Error(`意外 API：${endpoint}`)
  }
}

test('GitHub 按指定 attempt 分页，不接受别的工作流', () => {
  assert.equal(loadRun(1, 1, fakeApi({ pages: true })).jobs.length, 2)
  assert.throws(() => loadRun(1, 1, fakeApi({ path: '.github/workflows/ci.yml' })))
})

test('自动认出唯一用例；同 SHA 的用例通过即可，不要求后续无关用例也绿', () => {
  const record = prepareRecord({ run: '1', job: 'native / checks', 'pass-run': '2' }, fakeApi())
  assert.equal(record.test, '测试')
  assert.equal(record.event.evidence.kind, 'same-sha-pass')
  assert.equal(record.event.sha, sha)
})

test('通过证据的 SHA、用例及首次失败都核对，不以 job 成功冒充用例已跑', () => {
  const options = { run: '1', job: 'native / checks', 'pass-run': '2' }
  assert.throws(() => prepareRecord(options, fakeApi({ passSha: 'b'.repeat(40) })))
  assert.throws(() => prepareRecord(options, fakeApi({ passLog: '✔ 其他用例 (1ms)' })))
  assert.throws(() => prepareRecord(options, fakeApi({ passLog: '✖ 测试 (1ms)\n✔ 测试 (1ms)' })))
  assert.throws(() => prepareRecord({ ...options, case: '拼错' }, fakeApi()))
})

test('手工用例要失败说明，本地复跑要报告及说明，未确认记录保持 pending', () => {
  const options = { run: '1', job: 'native / checks', case: '手工用例' }
  assert.throws(() => prepareRecord({ ...options, manual: true }, fakeApi()))
  const record = prepareRecord(
    { ...options, manual: true, 'failure-note': '日志的具体失败位置' },
    fakeApi(),
  )
  assert.equal(record.event.evidence.kind, 'pending')
  assert.throws(() =>
    prepareRecord({ ...options, case: '测试', 'local-reference': 'report.md' }, fakeApi()),
  )
})

test('本地写入幂等，并发锁拒绝写入且不损坏已有账目', () => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-flaky-test-'))
  const path = join(dir, 'ledger.json')
  try {
    writeFileSync(path, JSON.stringify(ledger()))
    saveRecord(path, entry())
    saveRecord(path, entry())
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).cases[0].events.length, 1)
    writeFileSync(`${path}.lock`, '')
    assert.throws(() => saveRecord(path, entry(event(2))), /EEXIST/)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).cases[0].events.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('提交的真实账本有效，手机排除不污染审批次数', () => {
  const data = JSON.parse(
    readFileSync(new URL('../../docs/ci/flaky-ledger.json', import.meta.url), 'utf8'),
  )
  validateLedger(data)
})

test('侧栏投影按用户批准退出 Full：保留历史，后续登记也不再计数', () => {
  const data = JSON.parse(
    readFileSync(new URL('../../docs/ci/flaky-ledger.json', import.meta.url), 'utf8'),
  )
  const item = data.cases.find(
    (one) => one.job === 'native / checks' && one.test === 'client:projections',
  )
  assert.ok(item)
  assert.equal(item.status, 'excluded')
  assert.match(item.exclusion.reason, /已移出 Full（用户 D-98 批准，2026-11-07）/)
  assert.ok(item.events.length >= 4, '保留原有失败与重跑记录')
  assert.equal(counts(item).count, 0)
  const next = recordEvent(data, entry())
  const updated = next.cases.find((one) => one.job === item.job && one.test === item.test)
  assert.equal(updated.status, 'excluded')
  assert.equal(counts(updated).count, 0)
  assert.match(summary(next), /client:projections：0 次；待核实 0 次；已排除，不计数/)
})
