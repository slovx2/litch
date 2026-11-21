import assert from 'node:assert/strict'
import test from 'node:test'
import { ExternalFeedback } from '../src/external/feedback.mjs'
import { externalFixture } from './fixtures/external-c.mjs'

test('收件阶段每候选一条第一人称状态评论，@ 的原评论单独加 👀', async (t) => {
  const f = externalFixture(t)
  f.dispatchHost.feedbackWaitReason = () => 'manager_busy'
  const target = { publication: 'published', mentionsBot: true, mentionedBotId: '200' } as const
  const first = f.event('comment', { target })
  const second = f.event('comment', { target })
  await f.collect(first, second)
  await f.feedback.flush(f.scope)
  const create = f.feedbackWrites.find((intent) => intent.action === 'ack_comment_create')
  assert.ok(create)
  assert.equal(create.text, '收到，排队中，稍后就看（手头还有别的事）')
  assert.equal(create.identityId, 'bot-1')
  assert.deepEqual(
    f.feedbackWrites.map((intent) => intent.action),
    ['ack_comment_create', 'reaction_add', 'reaction_add'],
  )
  assert.deepEqual(
    f.feedbackWrites.flatMap((intent) =>
      intent.action === 'reaction_add' ? [[intent.comment.id, intent.reaction]] : [],
    ),
    [
      [first.targetEvidence.sourceEventId, 'eyes'],
      [second.targetEvidence.sourceEventId, 'eyes'],
    ],
  )
  f.clock.at += 30
  assert.equal(await f.dispatch.drain('m1'), true)
  await f.feedback.flush(f.scope)
  const update = f.feedbackWrites.find((intent) => intent.action === 'ack_comment_update')
  assert.equal(update?.text, '收到，我在看了')
  assert.equal(update?.createKey, create.idempotencyKey)
  await f.feedback.flush(f.scope)
  assert.equal(f.feedbackWrites.length, 4)
})

for (const lang of ['zh-CN', 'en'] as const)
  test(`${lang}：工具未更新的状态评论说清阻塞原因`, async (t) => {
    const f = externalFixture(t)
    f.feedbackHost.language = () => lang
    f.dispatchHost.feedbackWaitReason = () => 'manager_tools_outdated'
    await f.collect(f.event('assigned', { target: { assigneeUserId: '200' } }))
    await f.feedback.flush(f.scope)
    const [ack] = f.feedbackWrites
    assert.ok(ack?.action === 'ack_comment_create')
    assert.match(ack.text, lang === 'en' ? /GitHub tools are updated/ : /经理的 GitHub 工具更新后/)
    assert.doesNotMatch(ack.text, /busy|finishing something else|手头还有别的事/)
  })

test('已绑定评论只加 👀 / 🚀；发送未知不提前反馈，对账确认后只加一次', async (t) => {
  const f = externalFixture(t)
  const bound = f.event('comment')
  f.bind(bound, f.issue())
  await f.collect(bound, f.event('comment', { actor: '999' }))
  f.dispatchHost.send = async (request) => {
    const prepared = request.prepare()
    assert.ok(prepared && request.beforeSend(prepared))
    return { outcome: 'unknown' }
  }
  f.clock.at += 30
  assert.equal(await f.dispatch.drain('m1'), false)
  await f.feedback.flush(f.scope)
  assert.deepEqual(
    f.feedbackWrites.map((intent) => intent.action === 'reaction_add' && intent.reaction),
    ['eyes'],
  )
  const [group] = f.store.queue.deliveryGroups('m1', 'unknown')
  assert.ok(group)
  f.dispatch.confirmDelivery(group.groupId, 'verified-turn', f.clock.at)
  f.dispatch.confirmDelivery(group.groupId, 'verified-turn', f.clock.at)
  await f.feedback.flush(f.scope)
  assert.deepEqual(
    f.feedbackWrites.map((intent) => intent.action === 'reaction_add' && intent.reaction),
    ['eyes', 'rocket'],
  )
  assert.equal(f.store.inboxEvent(bound.externalEventKey)?.status, 'notified')
})

test('反馈关闭、被阻断、经理身份改变不写；D 暂不可用可以按同键恢复', async (t) => {
  const f = externalFixture(t)
  const assigned = (number: number, actor = '300') =>
    f.event('assigned', { number, actor, target: { assigneeUserId: '200' } })
  f.changeConfiguration({ repositories: [{ repoId: f.repo.repoId, immediateFeedback: false }] })
  await f.collect(assigned(1), assigned(2, '999'))
  f.clock.at += 30
  await f.dispatch.drain('m1')
  await f.feedback.flush(f.scope)
  assert.equal(f.feedbackWrites.length, 0)
  f.feedbackHost.language = () => 'en'
  f.changeConfiguration({ repositories: [{ repoId: f.repo.repoId }] })
  await f.collect(assigned(3), assigned(4, '999'))
  const enqueue = f.feedbackHost.enqueue
  const retryKeys: string[] = []
  f.feedbackHost.enqueue = async (intent) => {
    retryKeys.push(intent.idempotencyKey)
    return 'retry'
  }
  await f.feedback.flush(f.scope)
  f.feedbackHost.enqueue = enqueue
  const recovered = new ExternalFeedback(f.store, f.feedbackHost)
  await recovered.flush(f.scope)
  assert.equal(f.feedbackWrites.length, 1)
  const initial = f.feedbackWrites[0]
  assert.ok(initial?.action === 'ack_comment_create')
  assert.equal(initial.text, "Got it — queued, I'll take a look shortly.")
  assert.deepEqual(retryKeys, [initial.idempotencyKey])
  await f.collect(assigned(5))
  f.changeConfiguration({
    assignments: [{ managerId: 'm1', identityId: 'bot-2', repoIds: [f.repo.repoId] }],
  })
  await recovered.flush(f.scope)
  assert.equal(f.feedbackWrites.length, 1)
})
