import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import { NOTIFY_TTL } from '../src/external/intake.mjs'
import { repositoryRouting, validateExternalRoutes } from '../src/external/routing.mjs'
import {
  externalManagerUpgrade,
  managerBundle,
  managerFingerprint,
  refreshManagerRules,
} from '../src/manager-rules.mjs'
import { externalFixture } from './fixtures/external-c.mjs'

test('B 账本交接：四种显式触发、角色和编辑门槛，无关事件只记采集去重', async (t) => {
  const f = externalFixture(t)
  const mention = { publication: 'published', mentionsBot: true, mentionedBotId: '200' } as const
  const [body, assigned, review, label, outsider, forged, edited, noise, robot] = await f.collect(
    f.event('issue', { number: 1, target: mention }),
    f.event('assigned', { number: 2, target: { assigneeUserId: '200' } }),
    f.event('review_requested', { number: 3, pr: true, target: { reviewerUserId: '200' } }),
    f.event('labeled', { number: 4, target: { labelName: 'litch' } }),
    f.event('assigned', { number: 5, actor: '999', target: { assigneeUserId: '200' } }),
    f.event('labeled', { number: 6, actor: null, target: { labelId: '51', labelName: 'litch' } }),
    f.event('comment', { number: 7, target: { ...mention, publication: 'edited' } }),
    f.event('issue', { number: 8 }),
    f.event('comment', { number: 9, actor: '200', target: mention }),
  )
  assert.deepEqual(
    [body, assigned, review, label].map((row) => [row?.status, row?.ruleId]),
    [
      ['pending_triage', 'mention'],
      ['pending_triage', 'assignment'],
      ['pending_triage', 'review_request'],
      ['pending_triage', 'label'],
    ],
  )
  assert.equal(outsider?.reason, 'role_below_threshold')
  assert.equal(forged?.reason, 'actor_unverified')
  assert.equal(edited?.reason, 'edited_content')
  assert.equal(noise, null)
  assert.equal(robot, null)
  assert.equal(f.poll.evidence.pending(f.scope).length, 0)
  assert.equal(f.store.inbox().entries.length, 7)
})

test('同一仓库按两个经理身份分发，只采集一次；双 @ 只入箱，未分配的本机身份也不触发', async (t) => {
  const f = externalFixture(t)
  const both = [
    ...f.configuration().assignments,
    { managerId: 'm2', identityId: 'bot-2', repoIds: [f.repo.repoId] },
  ]
  f.changeConfiguration({
    assignments: both,
    repositories: [
      {
        repoId: f.repo.repoId,
        pollIdentity: 'bot-1',
        labelRoutes: [{ labelId: '51', managerId: 'm2' }],
      },
    ],
  })
  const addressed = f.event('comment', { number: 1, target: { publication: 'published' } })
  const conflicting = f.event('comment', { number: 2, target: { publication: 'published' } })
  f.addresses.set(addressed.externalEventKey, ['201'])
  f.addresses.set(conflicting.externalEventKey, ['200', '201'])
  const [one, conflict, assigned, asked, loop, defaultLabel] = await f.collect(
    addressed,
    conflicting,
    f.event('assigned', { number: 3, target: { assigneeUserId: '200' } }),
    f.event('review_requested', { number: 4, pr: true, target: { reviewerUserId: '201' } }),
    f.event('assigned', { number: 5, actor: '202', target: { assigneeUserId: '201' } }),
    f.event('labeled', { number: 6, target: { labelName: 'litch', labelId: '52' } }),
  )
  assert.equal(one?.managerId, 'm2')
  assert.equal(conflict?.reason, 'route_conflict')
  assert.equal(conflict?.managerId, undefined)
  assert.equal(assigned?.managerId, 'm1')
  assert.equal(asked?.managerId, 'm2')
  assert.equal(loop, null)
  assert.equal(defaultLabel?.reason, 'no_route')
  assert.equal(
    f.store.eventEvidence(addressed.externalEventKey)?.targetEvidence.mentionedBotId,
    undefined,
  )
  assert.deepEqual(f.store.routingEvidence(one!)?.addressedBotIds, ['201'])

  const label = f.event('labeled', { number: 7, target: { labelName: 'release' } })
  f.poll.evidence.stage(f.scope, [label], f.clock.at)
  await f.intake.consumeGithub(f.poll.evidence, f.scope, f.clock.at, {
    snapshotLabels: async (_source, _repo, event) => ({
      ...event,
      targetEvidence: { ...event.targetEvidence, labelId: '51', labelIds: ['51'] },
    }),
    inspectSubject: f.linkHost.inspectSubject,
  })
  assert.equal(f.store.inboxEvent(label.externalEventKey)?.managerId, 'm2')

  f.changeConfiguration({ assignments: [both[0]!, { ...both[1]!, identityId: 'bot-1' }] })
  assert.deepEqual(
    validateExternalRoutes(f.repo, repositoryRouting(f.configuration(), f.repo.repoId), (id) =>
      f.manager.manager(id),
    ),
    ['duplicate_repo_identity'],
  )
  f.changeConfiguration({ assignments: both })
  f.manager.saveManager({ ...f.makeManager('m2'), status: 'ended' })
  const [invalid] = await f.collect(
    f.event('assigned', { number: 8, target: { assigneeUserId: '201' } }),
  )
  assert.equal(invalid?.reason, 'route_target_invalid')
})

test('绑定优先；owner 数字 ID 无需提及；暂停、换线程、终态保留绑定', async (t) => {
  const f = externalFixture(t)
  f.changeConfiguration({
    assignments: [{ managerId: 'm2', identityId: 'bot-1', repoIds: [f.repo.repoId] }],
  })
  const comment = f.event('comment', {
    actor: '100',
    target: { publication: 'published' },
    contentVersion: 'comment-ver',
  })
  const issueId = f.issue()
  f.bind(comment, issueId)
  const [owner, collaborator, external, fromBot] = await f.collect(
    comment,
    f.event('review', { target: { publication: 'published' } }),
    f.event('comment', { actor: '999' }),
    f.event('comment', { actor: '200' }),
  )
  assert.equal(owner?.managerId, 'm1')
  assert.equal(owner?.actorRoleAtCheck, 'owner')
  assert.equal(collaborator?.ruleId, 'bound_follow_up')
  assert.equal(external?.status, 'blocked')
  assert.equal(fromBot, null)
  f.clock.at += 30
  f.source({ enabled: false })
  assert.equal(await f.dispatch.drain('m1'), false)
  f.manager.saveManager({ ...f.makeManager(), threadId: 'replacement' })
  assert.equal(f.store.ref(comment.targetEvidence.subject)?.issueId, issueId)
  f.source()
  f.dispatchHost.canDeliver = (manager) => manager.threadId === 'replacement'
  assert.equal(await f.dispatch.drain('m1'), true)
  const message = f.sent[0]!.text
  assert.doesNotMatch(message, /untrusted-name|https:\/\/|comment-ver/)
  assert.equal(parseSessionEvent(message).event?.kind, 'manager-external-bound')
  assert.equal(f.store.inboxEvent(comment.externalEventKey)?.status, 'notified')

  f.manager.saveIssue('m1', issueId, {
    ...(f.manager.issue('m1', issueId) as object),
    status: 'resolved',
  })
  const [status, explicit, ordinary] = await f.collect(
    f.event('closed'),
    f.event('labeled', { target: { labelId: '51', labelName: 'litch' } }),
    f.event('comment'),
  )
  assert.equal(status?.reason, 'terminal_issue')
  assert.equal(ordinary?.status, 'processed')
  assert.equal(explicit?.status, 'pending_triage')
  assert.equal(explicit?.issueId, issueId)
  f.clock.at += 35
  // 已结束事项上的明确请求照普通待分拣提醒，并标明原事项及其状态。
  assert.equal(await f.dispatch.drain('m1'), true)
  const reminder = parseSessionEvent(f.sent[1]!.text).event
  assert.equal(reminder?.kind, 'manager-external-triage')
  const payload = JSON.parse(reminder?.manager?.text ?? '{}')
  assert.deepEqual(payload.boundIssue, { issueId, status: 'resolved' })
  assert.match(payload.note, new RegExp(`relatedIssueId ${issueId}`))
  assert.equal(f.store.ref(comment.targetEvidence.subject)?.issueId, issueId)
  // 超过提醒时效的明确请求只留待人工分拣。
  const intakeId = explicit!.intakeId!
  f.manager.saveIssue('m1', issueId, {
    ...(f.manager.issue('m1', issueId) as object),
    status: 'closed',
  })
  const [stale] = await f.collect(
    f.event('labeled', {
      at: f.clock.at - NOTIFY_TTL - 1,
      target: { labelId: '51', labelName: 'litch' },
    }),
  )
  assert.equal(stale?.intakeId, intakeId)
  f.clock.at += 35
  assert.equal(await f.dispatch.drain('m1'), false)
  assert.equal(f.sent.length, 2)
})

test('聚合、审批停留和发送前二次准入；过载不丢收件箱', async (t) => {
  const f = externalFixture(t)
  const assigned = (number: number, actor = '300') =>
    f.event('assigned', { number, actor, target: { assigneeUserId: '200' } })
  const [first, duplicateTopic] = await f.collect(
    assigned(1),
    assigned(1),
    assigned(2),
    assigned(3),
    assigned(4),
  )
  assert.equal(first?.intakeId, duplicateTopic?.intakeId)
  assert.equal(await f.dispatch.drain('m1'), false)
  f.clock.at += 30
  const send = f.dispatchHost.send
  let approval = false
  f.dispatchHost.canDeliver = () => !approval
  f.dispatchHost.send = async (request) => {
    const prepared = request.prepare()
    assert.ok(prepared)
    approval = true
    assert.equal(request.beforeSend(prepared), null)
    return { outcome: 'not_sent' }
  }
  assert.equal(await f.dispatch.drain('m1'), false)
  assert.equal(f.sent.length, 0)
  assert.deepEqual(f.store.deliveryBudgetTimes('actor', '300', 0), [])
  approval = false
  f.dispatchHost.send = send
  assert.equal(await f.dispatch.drain('m1'), true)
  assert.equal(await f.dispatch.drain('m1'), true)
  assert.equal(await f.dispatch.drain('m1'), true)
  assert.equal(await f.dispatch.drain('m1'), false)
  assert.equal(f.store.inbox({ status: 'pending_triage' }).entries.length, 5)
  assert.equal(f.store.deliveryBudgetTimes('actor', '300', 0).length, 3)
  f.mandateHost.lookupGithubRole = async () => ({
    state: 'verified',
    eligible: true,
    roleName: 'triage',
  })
  await f.collect(assigned(5, '301'), assigned(6, '302'), assigned(7, '303'))
  f.clock.at += 30
  assert.equal(await f.dispatch.drain('m1'), true)
  assert.equal(await f.dispatch.drain('m1'), true)
  assert.equal(await f.dispatch.drain('m1'), false)
  assert.equal(f.store.deliveryBudgetTimes('source', f.scope.sourceId, 0).length, 5)
  f.clock.at += NOTIFY_TTL
  assert.equal(await f.dispatch.drain('m1'), false)
  assert.ok(f.store.inbox({ status: 'pending_triage', reason: 'notify_expired' }).entries.length)
})

test('未知发送稳态可对账；同一经理不会并发，也不重放旧队列', async (t) => {
  const f = externalFixture(t)
  await f.collect(
    f.event('assigned', { number: 1, target: { assigneeUserId: '200' } }),
    f.event('assigned', { number: 2, target: { assigneeUserId: '200' } }),
  )
  f.clock.at += 30
  let done!: () => void
  f.dispatchHost.send = async (request) => {
    const prepared = request.prepare()
    assert.ok(prepared && request.beforeSend(prepared))
    await new Promise<void>((resolve) => {
      done = resolve
    })
    return { outcome: 'unknown' }
  }
  const sending = f.dispatch.drain('m1')
  assert.equal(await f.dispatch.drain('m1'), false)
  f.dispatch.recover()
  done()
  assert.equal(await sending, false)
  const [group] = f.store.queue.deliveryGroups('m1', 'unknown')
  assert.equal(f.store.queue.deliveryGroupForDelivery(group!.deliveryId!)?.groupId, group!.groupId)
  assert.equal(await f.dispatch.drain('m1'), false)
})

test('未核验工具时提示刷新或更换线程，旧经理讨论规则保持原样', (t) => {
  const f = externalFixture(t)
  const manager = f.makeManager()
  const old = managerBundle(manager, true)
  const next = managerBundle(manager, true, true, [])
  const applied = { threadId: manager.threadId, fingerprint: managerFingerprint(old) }
  assert.deepEqual(externalManagerUpgrade(manager, applied, next, old), {
    ready: false,
    reason: 'manager_tools_outdated',
    action: 'replace',
  })
  assert.deepEqual(
    externalManagerUpgrade(
      manager,
      { ...applied, fingerprint: managerFingerprint(next) },
      next,
      next,
    ),
    { ready: true },
  )
  assert.equal(
    externalManagerUpgrade({ ...manager, threadId: 'replaced' }, applied, next, next).ready,
    false,
  )
  for (const field of ['description', 'instructions'] as const) {
    const changed = next.map((namespace) =>
      namespace.name === 'litch_manager'
        ? { ...namespace, [field]: `尚未更新的能力说明 ${namespace[field]}` }
        : namespace,
    )
    assert.equal(externalManagerUpgrade(manager, applied, next, changed).ready, false, field)
  }
  const legacy = old.find((namespace) => namespace.name === 'litch_manager')?.instructions ?? ''
  assert.equal(refreshManagerRules('litch_manager', legacy), legacy)
  assert.doesNotMatch(legacy, /external_inbox/)
})

test('权限暂不可用有界重查，超过期限记录原因并不再查询', async (t) => {
  const f = externalFixture(t)
  let calls = 0
  f.mandateHost.lookupGithubRole = async () => {
    calls++
    return { state: 'unavailable', reason: 'secondary-rate', retryAt: f.clock.at + 20 * 60 }
  }
  const event = f.event('assigned', { target: { assigneeUserId: '200' } })
  await f.collect(event)
  f.clock.at += 60
  await f.intake.processReceived(f.scope.sourceId, f.clock.at)
  assert.equal(calls, 1)
  f.clock.at += 14 * 60
  await f.intake.processReceived(f.scope.sourceId, f.clock.at)
  assert.equal(calls, 1)
  assert.equal(
    f.store.inboxEvent(event.externalEventKey)?.reason,
    'role_lookup_failed:secondary-rate',
  )
})

test('合并和关闭使用同一组状态提醒；停止后不补发已排队的绑定组', async (t) => {
  const f = externalFixture(t)
  const merged = f.event('merged', { actor: null, pr: true })
  const id = f.issue()
  f.bind(merged, id)
  await f.collect(merged, f.event('closed', { actor: null, pr: true }))
  f.clock.at += 30
  assert.equal(await f.dispatch.drain('m1'), true)
  assert.match(f.sent[0]!.text, /"category":"status","count":1/)
  assert.equal((f.manager.issue('m1', id) as { status: string }).status, 'open')
  await f.collect(f.event('comment', { pr: true, target: { publication: 'published' } }))
  f.store.stopIssueDeliveries('m1', id, f.clock.at, 'follow_up_off')
  f.clock.at += 30
  assert.equal(await f.dispatch.drain('m1'), false)
  assert.equal(f.store.ref(merged.targetEvidence.subject)?.issueId, id)
})

test('关跟进期间已采集的事件，恢复后才分拣也不补发', async (t) => {
  const f = externalFixture(t)
  const id = f.issue()
  const event = f.event('comment')
  f.bind(event, id)
  const issue = f.manager.issue('m1', id) as object
  const off = { ...issue, followUp: { state: 'off', changedAt: f.clock.at - 1, changedBy: 'user' } }
  const on = { ...issue, followUp: { state: 'on', changedAt: f.clock.at + 1, changedBy: 'user' } }
  f.manager.recordIssue('m1', id, 'user', issue, off, '关闭跟进')
  f.poll.evidence.stage(f.scope, [event], f.clock.at)
  f.manager.recordIssue('m1', id, 'user', off, on, '恢复跟进')
  f.manager.saveIssue('m1', id, on)
  f.clock.at += 2
  await f.intake.consumeGithub(f.poll.evidence, f.scope, f.clock.at, {
    inspectSubject: f.linkHost.inspectSubject,
    snapshotLabels: async (_source, _repo, event) => event,
  })
  assert.equal(f.store.inboxEvent(event.externalEventKey)?.reason, 'follow_up_off')
  assert.equal(f.store.queue.deliveryGroups('m1', 'queued').length, 0)
})

test('已提醒仍未分拣的待分拣，新的有效触发再提醒一次，只带新事件', async (t) => {
  const f = externalFixture(t)
  const [first] = await f.collect(f.event('assigned', { target: { assigneeUserId: '200' } }))
  const intakeId = first!.intakeId!
  f.clock.at += 35
  assert.equal(await f.dispatch.drain('m1'), true)
  const firstGroup = f.store.intake(intakeId)!.deliveryId!
  assert.equal(f.store.queue.deliveryGroup(firstGroup)?.state, 'confirmed')
  assert.equal(await f.dispatch.drain('m1'), false)

  f.clock.at += 60
  const mention = { publication: 'published', mentionsBot: true, mentionedBotId: '200' } as const
  const [nudge, second] = await f.collect(
    f.event('comment', { target: mention, contentVersion: 'nudge' }),
    f.event('comment', { target: mention, contentVersion: 'nudge-again' }),
  )
  assert.equal(nudge?.intakeId, intakeId)
  assert.equal(second?.intakeId, intakeId)
  const renotify = f.store.intake(intakeId)!.deliveryId!
  assert.notEqual(renotify, firstGroup)
  assert.deepEqual(f.store.queue.deliveryGroup(renotify)?.eventKeys, [
    nudge!.eventKey,
    second!.eventKey,
  ])
  f.clock.at += 35
  assert.equal(await f.dispatch.drain('m1'), true)
  assert.equal(f.sent.length, 2)
  const payload = JSON.parse(parseSessionEvent(f.sent[1]!.text).event?.manager?.text ?? '{}')
  assert.equal(payload.groupId, renotify)
  assert.equal(payload.count, 2)
  // 重复处理同一事件不再提醒。
  await f.intake.process(nudge!.eventKey, f.clock.at)
  f.clock.at += 35
  assert.equal(await f.dispatch.drain('m1'), false)
  assert.equal(f.sent.length, 2)
})
