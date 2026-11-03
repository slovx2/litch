import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateNightly, nightlySlot } from './nightly-health.mjs'
import { nightlyWriter, notifyNightly } from './nightly-notify.mjs'

const slot = Date.parse('2026-11-02T19:17:00Z')
const hour = 3600_000
function source(id = 1, changes = {}) {
  return {
    id,
    event: 'schedule',
    path: '.github/workflows/full.yml',
    head_sha: 'a'.repeat(40),
    run_attempt: 1,
    created_at: new Date(slot + hour).toISOString(),
    updated_at: new Date(slot + 2 * hour).toISOString(),
    status: 'completed',
    conclusion: 'success',
    coverage: 'complete',
    ...changes,
  }
}
const report = (hours, runs = [], extra = {}) =>
  evaluateNightly({
    runs,
    now: slot + hours * hour,
    monitoringSince: slot,
    workflowState: 'active',
    ...extra,
  })

test('90分钟只摘要，8小时迟到，24小时升级同一个缺跑key', () => {
  assert.equal(report(1).alerts.length, 0)
  assert.equal(report(1.5).alerts.length, 0)
  assert.match(report(1.5).notices.join(), /90分钟/)
  assert.equal(report(7.99).alerts.length, 0)
  const late = report(8).alerts.find((a) => a.key.startsWith('missing:'))
  const missed = report(24).alerts.find((a) => a.key === late.key)
  assert.equal(late.severity, 'warning')
  assert.equal(missed.severity, 'critical')
})

test('真实6小时17分39秒迟到不是漏跑；queued无runner与未创建区分', () => {
  const late = source(1, {
    created_at: '2026-11-03T01:34:39Z',
    status: 'queued',
    conclusion: null,
    coverage: 'unknown',
    acquired: false,
  })
  const result = report(8, [late])
  assert.equal(result.alerts.length, 0)
  assert.match(result.notices.join(), /等待runner/)
  assert.equal(result.samples[0].inferredDelayMinutes, 378)
  assert.equal(nightlySlot(Date.parse(late.created_at)), slot)
})

test('跨日新run不填旧槽；多run同槽必须显式报告歧义', () => {
  const next = source(2, { created_at: new Date(slot + 25 * hour).toISOString() })
  assert.ok(report(26, [next]).alerts.some((a) => a.key === `missing:${slot}`))
  assert.ok(report(8, [source(), source(2)]).alerts.some((a) => a.key.startsWith('ambiguous:')))
})

test('绿色证明36小时提醒、48小时保留全量规则；手动或无证明不能当绿色', () => {
  const green = source()
  assert.ok(!report(37.9, [green]).alerts.some((a) => a.key === 'green-baseline'))
  assert.equal(
    report(38, [green]).alerts.find((a) => a.key === 'green-baseline').severity,
    'warning',
  )
  assert.equal(
    report(50, [green]).alerts.find((a) => a.key === 'green-baseline').severity,
    'critical',
  )
  assert.equal(report(3, [source(1, { event: 'workflow_dispatch' })]).greenRun, null)
  assert.equal(report(3, [source(1, { coverage: 'unknown' })]).greenRun, null)
  assert.equal(report(3, [], { monitoringSince: slot + 3 * hour }).alerts.length, 0)
})

test('只有完整非手机证明加实际E2E失败能标手机单独红；APK/未知仍交经理分诊', () => {
  const mobile = source(1, {
    conclusion: 'failure',
    coverage: 'release-only',
    failures: [{ name: 'mobile (2)' }, { name: 'report' }],
  })
  assert.equal(report(3, [mobile]).alerts.find((a) => a.key === 'nightly-result').mobileOnly, true)
  for (const changes of [
    { coverage: 'unknown' },
    { failures: [{ name: 'mobile-build' }] },
    { failures: [{ name: 'native / checks' }] },
  ])
    assert.equal(
      report(3, [{ ...mobile, ...changes }]).alerts.find((a) => a.key === 'nightly-result')
        .mobileOnly,
      false,
    )
})

test('14次只数真实schedule独立run；重复attempt、dispatch不凑样本', () => {
  const runs = Array.from({ length: 14 }, (_, i) =>
    source(i + 1, {
      created_at: new Date(slot + i * 24 * hour + hour).toISOString(),
      updated_at: new Date(slot + i * 24 * hour + 2 * hour).toISOString(),
    }),
  )
  const result = report(14 * 24, [
    ...runs,
    { ...runs[0], run_attempt: 2 },
    source(99, { event: 'workflow_dispatch' }),
  ])
  assert.equal(result.samples.length, 14)
  assert.equal(result.reviewThreshold, true)
  assert.equal(report(13 * 24, runs.slice(0, 13)).reviewThreshold, false)
})

test('工作流停用和心跳迟到明确呈现，不自动启用或伪称监测实时', () => {
  const result = report(4, [source()], {
    workflowState: 'disabled_manually',
    previousHeartbeat: new Date(slot).toISOString(),
  })
  assert.ok(result.alerts.some((a) => a.key === 'workflow-state'))
  assert.equal(result.heartbeatGapMinutes, 240)
  assert.match(result.notices.join(), /监测本身/)
})

function service() {
  const machine = { issues: [], writes: [] }
  const read = (path) => {
    if (path.includes('/issues?')) return machine.issues
    if (path === 'repos/slovx2/litch/issues/9') return machine.issues[0]
    if (path.includes('/actions/runs/'))
      return {
        head_sha: 'b'.repeat(40),
        path: '.github/workflows/recovery-controller.yml',
        repository: { full_name: 'slovx2/litch' },
      }
    throw Error('unexpected read')
  }
  const write = (method, path, body) => {
    machine.writes.push({ method, path, body })
    if (method === 'POST')
      machine.issues.push({
        number: 9,
        state: 'open',
        user: { id: 41898282, login: 'github-actions[bot]' },
        ...body,
      })
    else Object.assign(machine.issues[0], body)
    return machine.issues[0]
  }
  return { machine, read, write }
}
const controller = { runId: 55, sha: 'b'.repeat(40) }

test('一条issue去重升级、恢复关闭、再次异常重开；每小时才刷新相同心跳', () => {
  const s = service()
  assert.equal(notifyNightly(report(1.5), controller, { ...s, now: slot }).state, 'no-alert')
  const late = report(8)
  assert.equal(notifyNightly(late, controller, { ...s, now: slot }).state, 'created')
  assert.equal(notifyNightly(late, controller, { ...s, now: slot + 10_000 }).state, 'unchanged')
  assert.equal(notifyNightly(report(24), controller, { ...s, now: slot + hour }).state, 'updated')
  const healthy = report(3, [source()])
  notifyNightly(healthy, controller, { ...s, now: slot + 2 * hour })
  assert.equal(s.machine.issues[0].state, 'closed')
  notifyNightly(late, controller, { ...s, now: slot + 3 * hour })
  assert.equal(s.machine.issues[0].state, 'open')
  assert.equal(s.machine.writes.filter((w) => w.method === 'POST').length, 1)
})

test('通知错误身份、重复issue或API写失败拒绝，不重复POST、不碰恢复API', () => {
  const s = service()
  notifyNightly(report(8), controller, { ...s, now: slot })
  s.machine.issues[0].user.id = 1
  assert.throws(() => notifyNightly(report(8), controller, s))
  s.machine.issues.push(s.machine.issues[0])
  assert.throws(() => notifyNightly(report(8), controller, s), /重复/)
  let calls = 0
  assert.throws(() =>
    notifyNightly(report(8), controller, {
      ...service(),
      write: () => {
        calls++
        throw Error('network')
      },
    }),
  )
  assert.equal(calls, 1)
  const writer = nightlyWriter(() => {
    throw Error('must not call')
  })
  assert.throws(() => writer('POST', 'repos/slovx2/litch/actions/runs/1/rerun-failed-jobs', {}))
  assert.throws(() => writer('DELETE', 'repos/slovx2/litch/issues/9', {}))
})
