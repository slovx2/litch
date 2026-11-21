import assert from 'node:assert/strict'
import test from 'node:test'
import { ExternalStore } from '../src/external-store.mjs'
import { ManagerStore, openManagerDatabase } from '../src/manager-store.mjs'
import { externalFixture } from './fixtures/external-c.mjs'

test('关闭未绑定待分拣：合并候选全部结算、取消待发提醒、审计幂等，持久化后仍可查', async (t) => {
  const f = externalFixture(t)
  const assigned = () => f.event('assigned', { target: { assigneeUserId: '200' } })
  const [first, second] = await f.collect(assigned(), assigned())
  assert.ok(first?.intakeId && second)
  const intake = f.store.intake(first.intakeId)
  assert.ok(intake?.deliveryId)
  assert.equal(first.intakeId, second.intakeId)
  assert.equal(f.store.inboxPending(f.scope.sourceId), 1)
  const subject = first.subject
  const observation = { subject, state: 'closed', updatedAt: f.clock.at + 1 } as const
  f.store.observeSubject(f.scope.sourceId, observation, f.clock.at + 2)
  const done = f.store.intake(intake.intakeId)
  assert.ok(done)
  assert.equal(done.status, 'processed')
  assert.equal(done.reason, 'external_closed')
  assert.equal(done.revision, intake.revision + 1)
  assert.equal(f.store.inboxPending(f.scope.sourceId), 0)
  assert.equal(f.store.inbox({ status: 'pending_triage' }).entries.length, 0)
  assert.equal(f.store.inbox({ status: 'processed' }).entries.length, 2)
  for (const row of f.store.inbox().entries) assert.equal(row.reason, 'external_closed')
  assert.equal(f.store.queue.deliveryGroup(intake.deliveryId)?.state, 'blocked')
  assert.equal(f.store.queue.deliveryGroup(intake.deliveryId)?.reason, 'external_closed')
  assert.equal(await f.dispatch.drain('m1'), false)
  assert.deepEqual(f.sent, [])
  assert.equal(f.store.ref(subject), null)
  assert.deepEqual(f.manager.issues('m1'), [])
  const audits = f.store.audit(first.subjectKey).filter((row) => row.action === 'intake_obsoleted')
  assert.equal(audits.length, 1)
  assert.equal(audits[0]?.reason, 'external_closed')
  assert.equal(audits[0]?.previousState, 'pending_triage')
  assert.deepEqual(audits[0]?.eventKeys, intake.eventKeys)
  f.store.observeSubject(f.scope.sourceId, observation, f.clock.at + 3)
  assert.equal(f.store.intake(intake.intakeId)?.revision, done.revision)
  const reopened = new ManagerStore(openManagerDatabase(f.repo.localRoot))
  try {
    assert.deepEqual(new ExternalStore(reopened).intake(intake.intakeId), done)
  } finally {
    reopened.close()
  }
})

test('已提醒仍待分拣的 PR 合并后结算；保留确认回执、不新增反馈写入', async (t) => {
  const f = externalFixture(t)
  const [row] = await f.collect(
    f.event('review_requested', {
      pr: true,
      target: { reviewerUserId: '200' },
    }),
  )
  f.clock.at += 30
  assert.equal(await f.dispatch.drain('m1'), true)
  assert.ok(row?.intakeId)
  const intake = f.store.intake(row.intakeId)
  assert.ok(intake?.deliveryId)
  const feedback = f.feedbackWrites.length
  f.store.observeSubject(
    f.scope.sourceId,
    {
      subject: row.subject,
      state: 'merged',
      updatedAt: f.clock.at,
    },
    f.clock.at,
  )
  assert.equal(f.store.intake(intake.intakeId)?.reason, 'external_merged')
  assert.equal(f.store.inboxEvent(row.eventKey)?.status, 'processed')
  assert.equal(f.store.queue.deliveryGroup(intake.deliveryId)?.state, 'confirmed')
  assert.equal(f.sent.length, 1)
  assert.equal(f.feedbackWrites.length, feedback)
})

test('关闭快照先到也不残留候选或排提醒；重新打开不复活旧候选，新触发重新分拣', async (t) => {
  const f = externalFixture(t)
  const trigger = f.event('assigned', { target: { assigneeUserId: '200' } })
  const observation = { subject: trigger.targetEvidence.subject, updatedAt: f.clock.at }
  f.store.observeSubject(f.scope.sourceId, { ...observation, state: 'closed' }, f.clock.at)
  const [row] = await f.collect(trigger)
  assert.ok(row?.intakeId)
  assert.equal(row.reason, 'external_closed')
  const old = f.store.intake(row.intakeId)
  assert.ok(old)
  assert.equal(old.status, 'processed')
  assert.equal(old.deliveryId, undefined)
  await f.feedback.flush(f.scope)
  assert.deepEqual(f.feedbackWrites, [])
  f.clock.at += 10
  f.store.observeSubject(
    f.scope.sourceId,
    {
      ...observation,
      state: 'open',
      updatedAt: f.clock.at,
    },
    f.clock.at,
  )
  assert.equal(f.store.intake(old.intakeId)?.status, 'processed')
  const [reopened] = await f.collect(f.event('reopened'))
  assert.equal(reopened, null)
  const [next] = await f.collect(f.event('assigned', { target: { assigneeUserId: '200' } }))
  assert.ok(next?.intakeId)
  assert.equal(next.status, 'pending_triage')
  assert.notEqual(next.intakeId, old.intakeId)
  // 晚到的旧目录页不能覆盖重新打开的状态。
  f.store.observeSubject(f.scope.sourceId, { ...observation, state: 'closed' }, f.clock.at)
  assert.equal(f.store.intake(next.intakeId)?.status, 'pending_triage')
})

test('绑定、来源和事件时间隔离：不结算已绑定主题、别的来源或比快照更新的请求', async (t) => {
  const f = externalFixture(t)
  const trigger = f.event('assigned', { target: { assigneeUserId: '200' } })
  const [row] = await f.collect(trigger)
  assert.ok(row?.intakeId)
  const close = { subject: row.subject, state: 'closed', updatedAt: f.clock.at } as const
  f.store.observeSubject('another-source', close, f.clock.at)
  assert.equal(f.store.intake(row.intakeId)?.status, 'pending_triage')
  f.store.observeSubject(f.scope.sourceId, { ...close, updatedAt: f.clock.at - 1 }, f.clock.at)
  assert.equal(f.store.intake(row.intakeId)?.status, 'pending_triage')
  f.bind(trigger, f.issue())
  const before = f.store.intake(row.intakeId)
  f.store.observeSubject(f.scope.sourceId, close, f.clock.at)
  assert.deepEqual(f.store.intake(row.intakeId), before)
  assert.equal(f.store.inboxEvent(row.eventKey)?.status, 'pending_triage')
})
