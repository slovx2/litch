// 审计记录的纯状态机；传输层须串行、验证issue/comment作者，再使用这里的链。
// 此文件不读写GitHub，不执行重跑；第一阶段只能生成observation。
import assert from 'node:assert/strict'
import { evidenceHash, recoveryVersion } from './recovery-policy.mjs'

export const sourceKey = (plan) => `${plan.repository}:${plan.runId}:${plan.sha}`

function assertReservation(plan, now) {
  assert.equal(plan.decision, 'eligible')
  assert.equal(plan.attempt, 1)
  assert.equal(plan.sourceBinding?.matched, true, '来源契约未核实')
  assert.equal(plan.dependencyClosureVerified, true, '未核实重跑下游，不能预占预算')
  assert.ok(Date.parse(plan.expiresAt) > now, '恢复窗口已过')
  assert.ok(plan.roots.length > 0)
  assert.equal(new Set(plan.roots.map((root) => root.name)).size, plan.roots.length)
  for (const root of plan.roots)
    assert.ok(
      plan.jobs.some((job) => job.id === root.id && job.name === root.name && job.kind === 'infra'),
      '失败根未绑定',
    )
}

export function auditRecord(plan, type, details, previous = null, now = Date.now()) {
  assert.equal(plan.rule, recoveryVersion)
  assert.ok(
    ['observation', 'reservation', 'dispatched', 'uncertain', 'resolved', 'aborted'].includes(type),
  )
  assert.ok(Number.isFinite(now))
  if (type === 'reservation') assertReservation(plan, now)
  const value = {
    schema: 1,
    rule: recoveryVersion,
    source: sourceKey(plan),
    type,
    at: new Date(now).toISOString(),
    planHash: evidenceHash(plan),
    previous: previous?.hash ?? null,
    details,
  }
  return { ...value, hash: evidenceHash(value) }
}

export function readAudit(records, plan) {
  let state = 'empty'
  let previous = null
  let reservation = null
  let observedAttempt = null
  for (const record of records) {
    const { hash, ...value } = record
    assert.equal(record.schema, 1, '审计schema')
    assert.equal(record.rule, recoveryVersion, '审计规则版本')
    assert.equal(record.source, sourceKey(plan), '审计源run/SHA不符')
    assert.equal(hash, evidenceHash(value), '审计记录被改动')
    assert.equal(record.previous, previous?.hash ?? null, '审计链缺失或乱序')
    assert.ok(Number.isFinite(Date.parse(record.at)), '审计时间')
    if (previous) assert.ok(Date.parse(record.at) >= Date.parse(previous.at), '审计时间倒退')
    if (record.type === 'observation') {
      // 观察不能释放已经占用的预算；多次回放只是多条诊断。
    } else if (record.type === 'reservation') {
      assert.equal(state, 'empty', '同源run不能第二次reservation')
      assert.equal(record.planHash, evidenceHash(plan), 'reservation计划已变')
      assertReservation(plan, Date.parse(record.at))
      state = 'reserved'
      reservation = record.hash
    } else if (record.type === 'uncertain') {
      assert.equal(state, 'reserved', '只有已预占的调用可变为不确定')
      state = 'uncertain'
    } else if (record.type === 'dispatched') {
      assert.ok(['reserved', 'uncertain'].includes(state), '没有reservation或重复调用')
      assert.equal(record.details.attempt, 2, '首版只接受下一attempt')
      assert.equal(record.details.reservation, reservation, '调用来源reservation')
      state = 'dispatched'
      observedAttempt = record.details.attempt
    } else if (record.type === 'resolved') {
      assert.ok(['dispatched', 'uncertain'].includes(state), '没有待核实调用')
      assert.ok(
        ['success', 'failure', 'cancelled', 'not-observed'].includes(record.details.conclusion),
      )
      assert.equal(record.details.reservation, reservation)
      state = 'resolved'
    } else if (record.type === 'aborted') {
      assert.equal(state, 'reserved')
      assert.equal(record.details.reservation, reservation)
      state = 'resolved'
    } else {
      assert.fail('未知审计事件')
    }
    previous = record
  }
  return { state, reserved: state !== 'empty', reservation, observedAttempt, last: previous }
}

export function observation(plan, now = Date.now()) {
  // 仅固定分类与来源链接，不记录日志正文、环境、令牌或命令输出。
  return auditRecord(
    plan,
    'observation',
    {
      decision: plan.decision,
      reason: plan.reason,
      runUrl: `https://github.com/${plan.repository}/actions/runs/${plan.runId}`,
      jobs: plan.jobs.map(({ id, name, kind, reason, step, evidenceHash: hash }) => ({
        id,
        name,
        kind,
        reason,
        ...(step ? { step } : {}),
        ...(hash ? { evidenceHash: hash } : {}),
      })),
    },
    null,
    now,
  )
}
