import assert from 'node:assert/strict'
import test from 'node:test'
import { projectExternalManagerPayload } from '../../protocol/src/external-sources.mjs'
import { externalFixture } from './fixtures/external-c.mjs'

test('并发受理只有一张 X-n；同键可重读，改参数冲突', async (t) => {
  const f = externalFixture(t)
  const [event] = await f.collect(f.event('assigned', { target: { assigneeUserId: '200' } }))
  const intake = f.store.intake(event!.intakeId!)!
  const request = {
    intakeId: intake.intakeId,
    expectedRevision: intake.revision,
    action: 'accept' as const,
    idempotencyKey: 'take',
    title: '内部标题',
    body: '内部工作描述',
  }
  const both = await Promise.all([
    f.mandates.decide(f.context, request),
    f.mandates.decide(f.context, { ...request, idempotencyKey: 'other' }),
  ])
  assert.deepEqual(both.map((result) => result.outcome).sort(), ['applied', 'conflict'])
  assert.equal(f.manager.issues('m1').length, 1)
  assert.equal(f.store.refs('m1', 'X-1').length, 1)
  const [mandate] = f.store.mandates('m1', 'X-1')
  assert.equal(mandate?.requesterUserId, '300')
  assert.deepEqual(mandate?.authorizedScope.actions, ['comment'])
  assert.deepEqual(await f.mandates.decide(f.context, request), both[0])
  const changed = await f.mandates.decide(f.context, { ...request, title: '不同标题' })
  assert.equal(changed.outcome, 'conflict')
  if (changed.outcome === 'conflict') assert.equal(changed.reason, 'idempotency')
  await assert.rejects(
    f.tools.call({ ...f.context, threadId: 'stale' }, 'external_inbox_list', {}),
    /current active/,
  )
  await assert.rejects(
    f.tools.call({ ...f.context, managerId: 'm2', threadId: 'm2-thread' }, 'external_inbox_get', {
      intakeId: intake.intakeId,
    }),
    /Unknown intake/,
  )
})

test('触发已删除、已撤销或规则改变时，必须有同候选的独立有效证据', async (t) => {
  const f = externalFixture(t)
  const deleted = f.event('comment', {
    target: { publication: 'published', mentionsBot: true, mentionedBotId: '200' },
    contentVersion: 'quoted',
  })
  const [row] = await f.collect(deleted)
  const request = () => ({
    action: 'accept' as const,
    intakeId: row!.intakeId!,
    expectedRevision: f.store.intake(row!.intakeId!)!.revision,
    idempotencyKey: 'take',
    title: '内部',
    body: '',
  })
  f.mandateHost.recheckEvent = async ({ event }) =>
    event.externalEventKey === deleted.externalEventKey
      ? null
      : { event, agentMarked: false, addressedBotIds: [] }
  await assert.rejects(f.mandates.decide(f.context, request()), /No trigger in this intake/)
  f.clock.at++
  await f.collect(f.event('assigned', { target: { assigneeUserId: '200' } }))
  f.source({ triggers: { ...f.draft.triggers, assignment: false } })
  await assert.rejects(f.mandates.decide(f.context, request()), /No trigger in this intake/)
  assert.equal(f.manager.issues('m1').length, 0)
  f.source()
  f.clock.at++
  await f.collect(f.event('unassigned', { target: { assigneeUserId: '200' } }))
  await assert.rejects(f.mandates.decide(f.context, request()), /No trigger in this intake/)
  f.clock.at++
  const [newEvent] = await f.collect(
    f.event('labeled', { target: { labelId: '61', labelName: 'litch' } }),
  )
  const result = await f.mandates.decide(f.context, request())
  assert.equal(result.outcome, 'applied')
  if (result.outcome === 'applied')
    assert.deepEqual(result.mandate?.eventKeys, [newEvent!.eventKey])
})

test('原文仍有效也不能用已改派路线或已撤销身份接单', async (t) => {
  const f = externalFixture(t)
  const [row] = await f.collect(
    f.event('issue', {
      target: { publication: 'published', mentionsBot: true, mentionedBotId: '200' },
      contentVersion: 'original-body',
    }),
  )
  assert.ok(row?.intakeId)
  const request = {
    action: 'accept' as const,
    intakeId: row.intakeId,
    expectedRevision: f.store.intake(row.intakeId)!.revision,
    idempotencyKey: 'take',
    title: '内部',
    body: '',
  }
  const { assignments } = f.configuration()
  f.changeConfiguration({ assignments: assignments.map((one) => ({ ...one, managerId: 'm2' })) })
  await assert.rejects(f.mandates.decide(f.context, request), /No trigger in this intake/)
  f.changeConfiguration({ assignments })
  const credential = f.store.config.credential(f.draft.credentialRef)
  assert.ok(credential)
  const revoked = f.store.config.saveCredential(
    { ...credential, state: 'revoked', generation: credential.generation + 1 },
    credential.generation,
    'revoke',
  )
  assert.equal(revoked.outcome, 'applied')
  await assert.rejects(f.mandates.decide(f.context, request), /scope is unavailable/)
  assert.equal(f.manager.issues('m1').length, 0)
})

test('并入重验议题版本和范围，暂停/换线程拒绝旧处置，写开关关闭仍可忽略', async (t) => {
  const f = externalFixture(t)
  const [row] = await f.collect(f.event('assigned', { target: { assigneeUserId: '200' } }))
  const intake = f.store.intake(row!.intakeId!)!
  const issueId = f.issue()
  const request = {
    action: 'merge' as const,
    issueId,
    expectedIssueRevision: 1,
    intakeId: intake.intakeId,
    expectedRevision: intake.revision,
    idempotencyKey: 'merge',
  }
  const conflict = await f.mandates.decide(f.context, { ...request, expectedIssueRevision: 2 })
  assert.equal(conflict.outcome === 'conflict' && conflict.reason, 'issue_revision')
  f.mandateHost.recheckEvent = async ({ event }) => {
    f.source({ enabled: false })
    return { event, agentMarked: false, addressedBotIds: [] }
  }
  await assert.rejects(f.mandates.decide(f.context, request), /scope is unavailable/)
  f.source({ writePolicy: { ...f.draft.writePolicy, comment: false } })
  f.mandateHost.recheckEvent = async ({ event }) => {
    f.manager.saveManager({ ...f.makeManager(), threadId: 'new-thread' })
    return { event, agentMarked: false, addressedBotIds: [] }
  }
  await assert.rejects(f.mandates.decide(f.context, request), /current active/)
  f.mandateHost.recheckEvent = async ({ event }) => ({
    event,
    agentMarked: false,
    addressedBotIds: [],
  })
  const result = await f.tools.call({ ...f.context, threadId: 'new-thread' }, 'external_ignore', {
    intakeId: intake.intakeId,
    expectedRevision: intake.revision,
    idempotencyKey: 'ignore',
    reason: '内部原因',
    reply: '公开回复',
  })
  assert.equal((result as { outcome: string }).outcome, 'applied')
  assert.deepEqual((result as { reply: unknown }).reply, { notQueued: 'comment_disabled' })
  assert.equal(f.store.queue.outbox({}).entries.length, 0)
})

test('终态上的新请求只能明确建内部后续，不能改变旧绑定或获得回写权限', async (t) => {
  const f = externalFixture(t)
  const label = f.event('labeled', { target: { labelId: '42', labelName: 'litch' } })
  const old = f.issue('m1', { status: 'closed' })
  f.bind(label, old)
  const [row] = await f.collect(label)
  const intake = f.store.intake(row!.intakeId!)!
  const params = {
    action: 'accept' as const,
    title: '新的内部工作',
    body: '',
    intakeId: intake.intakeId,
    expectedRevision: intake.revision,
    idempotencyKey: 'accept',
  }
  const conflict = await f.mandates.decide(f.context, params)
  assert.equal(conflict.outcome === 'conflict' && conflict.reason, 'binding')
  const result = await f.mandates.decide(f.context, { ...params, relatedIssueId: old })
  assert.equal(result.outcome, 'applied')
  if (result.outcome === 'applied') assert.deepEqual(result.mandate?.authorizedScope.actions, [])
  assert.equal(f.store.ref(label.targetEvidence.subject)?.issueId, old)
  assert.equal((f.manager.issue('m1', old) as { status: string }).status, 'closed')
})

test('决策只采纳当前 owner 原评论；版本、范围、Agent 标记与旧连接裁剪', async (t) => {
  const f = externalFixture(t)
  const comment = f.event('comment', {
    actor: '100',
    target: { publication: 'published' },
    contentVersion: 'issued-version',
  })
  f.bind(comment, f.issue())
  const collaborator = f.event('comment', {
    actor: '300',
    target: { publication: 'published' },
    contentVersion: 'not-owner',
  })
  await f.collect(comment, collaborator)
  const d = f.board.tool('m1', 'add', {
    kind: 'decision',
    decision: { title: '验收', background: '背景' },
  }) as {
    object: { id: string; revision: number }
  }
  const input = {
    id: d.object.id,
    expectedDecisionRevision: d.object.revision,
    optionId: null,
    text: '继续。',
  }
  await assert.rejects(
    f.tools.call(f.context, 'answer', { ...input, ownerEventKey: collaborator.externalEventKey }),
    /configured GitHub owner/,
  )
  f.mandateHost.recheckEvent = async ({ event }) => ({
    event,
    agentMarked: true,
    addressedBotIds: [],
  })
  await assert.rejects(
    f.tools.call(f.context, 'answer', { ...input, ownerEventKey: comment.externalEventKey }),
    /not be verified/,
  )
  f.mandateHost.recheckEvent = async ({ event }) => ({
    event: { ...event, contentVersion: 'edited' },
    agentMarked: false,
    addressedBotIds: [],
  })
  await assert.rejects(
    f.tools.call(f.context, 'answer', { ...input, ownerEventKey: comment.externalEventKey }),
    /not be verified/,
  )
  f.mandateHost.recheckEvent = async ({ event }) => ({
    event,
    agentMarked: false,
    addressedBotIds: [],
  })
  const result = (await f.tools.call(f.context, 'answer', {
    ...input,
    ownerEventKey: comment.externalEventKey,
  })) as {
    object: { answer: { answerSource?: { actorUserId: string } } }
  }
  assert.equal(result.object.answer.answerSource?.actorUserId, '100')
  assert.equal(
    projectExternalManagerPayload(result, new Set(['litchManager'])).object.answer.answerSource,
    undefined,
  )
  assert.equal(
    projectExternalManagerPayload(result, new Set(['litchManager', 'litchExternalSources'])).object
      .answer.answerSource?.actorUserId,
    '100',
  )
})

test('观察到 Agent PR 只留待绑定提示，显式绑定重验数字仓库与唯一性', async (t) => {
  const f = externalFixture(t)
  const pr = f.event('pull_request', { number: 9, actor: '200' })
  const [row] = await f.collect(pr)
  assert.equal(row?.reason, 'agent_pr_needs_link')
  assert.equal(f.store.queue.deliveryGroups('m1', 'queued').length, 0)
  const input = {
    sourceId: f.scope.sourceId,
    repoId: f.repo.repoId,
    number: '9',
    kind: 'pull_request',
    issueId: f.issue(),
    expectedIssueRevision: 1,
  }
  await assert.rejects(
    f.tools.call(f.context, 'external_link', { ...input, repoId: '999' }),
    /outside an enabled/,
  )
  const result = (await f.tools.call(f.context, 'external_link', input)) as { outcome: string }
  assert.equal(result.outcome, 'applied')
  assert.equal(f.store.inboxEvent(pr.externalEventKey)?.reason, 'agent_pr_bound')
  assert.equal(f.store.ref(pr.targetEvidence.subject)?.issueId, input.issueId)
  const duplicate = (await f.tools.call(f.context, 'external_link', input)) as { reason: string }
  assert.equal(duplicate.reason, 'binding')
  f.mandateHost.recheckEvent = async ({ event }) => ({
    event,
    agentMarked: true,
    addressedBotIds: [],
  })
  const [ownerAgent] = await f.collect(
    f.event('comment', {
      number: 9,
      pr: true,
      actor: '100',
      target: { publication: 'published' },
      contentVersion: 'new',
    }),
  )
  assert.equal(ownerAgent?.reason, 'agent_action')
})

test('可选自动关联只接受观察到的机器人 PR 和已核验的关联', async (t) => {
  const f = externalFixture(t)
  const issue = f.issue('m2')
  f.bind(f.event('issue'), issue, 'm2')
  f.changeConfiguration({
    assignments: [
      ...f.configuration().assignments,
      { managerId: 'm2', identityId: 'bot-2', repoIds: [f.repo.repoId] },
    ],
  })
  const inspect = f.linkHost.inspectSubject
  f.linkHost.inspectSubject = async (input) => {
    const proof = await inspect(input)
    return proof ? { ...proof, actorUserId: '201' } : null
  }
  f.linkHost.resolveAgentPr = () => ({ managerId: 'm1', issueId: issue, association: 'head' })
  const agentPr = f.event('pull_request', { number: 9, actor: '201' })
  const impersonation = f.event('pull_request', { number: 8, actor: '100' })
  assert.equal(await f.links.observeAgentPr(f.scope.sourceId, impersonation), false)
  assert.equal(await f.links.observeAgentPr(f.scope.sourceId, agentPr), false)
  f.linkHost.resolveAgentPr = () => ({ managerId: 'm2', issueId: issue, association: 'head' })
  f.poll.evidence.stage(f.scope, [agentPr], f.clock.at)
  await f.intake.consumeGithub(
    f.poll.evidence,
    f.scope,
    f.clock.at,
    {
      inspectSubject: f.linkHost.inspectSubject,
      snapshotLabels: async (_source, _repo, event) => event,
    },
    (sourceId, event) => f.links.observeAgentPr(sourceId, event),
  )
  assert.equal(f.store.ref(agentPr.targetEvidence.subject)?.issueId, issue)
  assert.equal(f.store.ref(agentPr.targetEvidence.subject)?.managerId, 'm2')
  assert.equal(f.store.inboxEvent(agentPr.externalEventKey)?.reason, 'agent_pr_bound')
  assert.equal(f.store.queue.deliveryGroups('m2', 'queued').length, 0)
})

test('D-140 配置在核验期间改变，不能按旧身份分配完成受理', async (t) => {
  const f = externalFixture(t)
  const [row] = await f.collect(f.event('assigned', { target: { assigneeUserId: '200' } }))
  const intake = f.store.intake(row!.intakeId!)!
  f.mandateHost.recheckEvent = async ({ event }) => {
    f.changeConfiguration({ assignments: [] })
    return { event, agentMarked: false, addressedBotIds: [] }
  }
  await assert.rejects(
    f.mandates.decide(f.context, {
      action: 'accept',
      intakeId: intake.intakeId,
      expectedRevision: intake.revision,
      idempotencyKey: 'stale-config',
      title: '当前配置变化',
      body: '',
    }),
    /configuration changed/,
  )
  assert.equal(f.manager.issues('m1').length, 0)
})

test('原触发被编辑后，后加入的有效触发可接单；全部失效时设备收尾', async (t) => {
  const f = externalFixture(t)
  const mention = { publication: 'published', mentionsBot: true, mentionedBotId: '200' } as const
  const original = f.event('comment', { target: mention, contentVersion: 'v1' })
  const [first] = await f.collect(original)
  const intakeId = first!.intakeId!
  f.clock.at++
  const [later] = await f.collect(f.event('comment', { target: mention, contentVersion: 'later' }))
  assert.equal(later?.intakeId, intakeId)
  f.clock.at++
  const edit = f.event('comment', {
    target: {
      ...mention,
      publication: 'edited',
      sourceEventId: original.targetEvidence.sourceEventId,
    },
    contentVersion: 'v2',
  })
  const [edited] = await f.collect(edit)
  assert.equal(edited?.reason, 'edited_content')
  // 仍有有效触发，候选不收尾，接单以后加入的那条为依据。
  assert.equal(f.store.intake(intakeId)?.status, 'pending_triage')
  const result = await f.mandates.decide(f.context, {
    action: 'accept',
    intakeId,
    expectedRevision: f.store.intake(intakeId)!.revision,
    idempotencyKey: 'take',
    title: '内部',
    body: '',
  })
  assert.equal(result.outcome, 'applied')
  if (result.outcome === 'applied') assert.deepEqual(result.mandate?.eventKeys, [later!.eventKey])

  // 唯一的触发被编辑：设备收尾，不再挂在待分拣。
  f.clock.at++
  const lone = f.event('comment', { number: 2, target: mention, contentVersion: 'lone-v1' })
  const [loneRow] = await f.collect(lone)
  const loneIntake = loneRow!.intakeId!
  f.clock.at++
  await f.collect(
    f.event('comment', {
      number: 2,
      target: {
        ...mention,
        publication: 'edited',
        sourceEventId: lone.targetEvidence.sourceEventId,
      },
      contentVersion: 'lone-v2',
    }),
  )
  assert.equal(f.store.intake(loneIntake)?.status, 'processed')
  assert.equal(f.store.intake(loneIntake)?.reason, 'trigger_invalid')
  assert.equal(f.store.inboxEvent(loneRow!.eventKey)?.reason, 'trigger_invalid')
})

test('分拣时触发全部失效：报清原因；确定失效即收尾，不确定的可忽略', async (t) => {
  const f = externalFixture(t)
  const mention = { publication: 'published', mentionsBot: true, mentionedBotId: '200' } as const
  const accept = (intakeId: string) => ({
    action: 'accept' as const,
    intakeId,
    expectedRevision: f.store.intake(intakeId)!.revision,
    idempotencyKey: `take-${intakeId}`,
    title: '内部',
    body: '',
  })
  const recheck = f.mandateHost.recheckEvent
  // GitHub 上的当前版本已不同于采集时：确定失效。
  const [changed] = await f.collect(f.event('comment', { target: mention, contentVersion: 'old' }))
  f.mandateHost.recheckEvent = async ({ event }) => ({
    event: { ...event, contentVersion: 'new' },
    agentMarked: false,
    addressedBotIds: ['200'],
  })
  await assert.rejects(
    f.mandates.decide(f.context, accept(changed!.intakeId!)),
    (error: Error) =>
      error.message.includes(changed!.eventKey) &&
      /differs from the collected version/.test(error.message) &&
      /moved this intake to processed \(reason trigger_invalid\)/.test(error.message),
  )
  assert.equal(f.store.intake(changed!.intakeId!)?.status, 'processed')
  assert.equal(f.store.intake(changed!.intakeId!)?.reason, 'trigger_invalid')

  // 原文暂时取不到：保留候选，提示重试或忽略，忽略不需要有效触发。
  f.clock.at++
  f.mandateHost.recheckEvent = recheck
  const [unreachable] = await f.collect(
    f.event('comment', { number: 3, target: mention, contentVersion: 'x' }),
  )
  f.mandateHost.recheckEvent = async () => null
  const intakeId = unreachable!.intakeId!
  await assert.rejects(
    f.mandates.decide(f.context, accept(intakeId)),
    (error: Error) =>
      /did not return the original content/.test(error.message) &&
      /external_ignore/.test(error.message),
  )
  assert.equal(f.store.intake(intakeId)?.status, 'pending_triage')
  const ignored = await f.mandates.decide(f.context, {
    action: 'ignore',
    intakeId,
    expectedRevision: f.store.intake(intakeId)!.revision,
    idempotencyKey: 'drop',
    reason: '无法核验',
    reply: '请重新发一条评论',
  })
  assert.equal(ignored.outcome, 'applied')
  if (ignored.outcome === 'applied') {
    assert.equal(ignored.intake.reason, 'ignored')
    assert.deepEqual(ignored.reply, { notQueued: 'comment_disabled' })
  }
})
