// F6：私聊绑定与飞书卡片审批。真实 SDK 连回环上的假飞书，经理跑在假引擎上：
// 没绑定的人私聊只拿到配对码（不落库、限流、限量），管理员按码确认后绑定并回“已绑定”；
// 已绑定的人私聊每条都进收件箱叫醒经理，经理用 user 回私聊（不审批），撤销后又和没绑定一样；
// 审批人在飞书私聊收审批卡片，点按钮经长连接回调批准，卡片换成结果；在 Litch 里批的卡片也跟着改。
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { FEISHU_TOOLS_NAMESPACE } from '../../protocol/src/client-tools-feishu.mjs'
import { type FeishuBinding, FEISHU_METHOD as M } from '../../protocol/src/feishu.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { REVIEWS_METHOD as R } from '../../protocol/src/reviews.mjs'
import { FakeEngine, failureOf, resultOf } from './fake-engine.mjs'
import { FeishuFakeHarness } from './feishu-harness.mjs'
import { until } from './tree-kit.mjs'

const APP = 'cli_0123456789abcdef'
const GATED = 'oc_gated'
const CAROL = 'ou_carol'
const DAVE = 'ou_dave'
const p2p = (openId: string) => `oc_p2p_${openId}`
const codeIn = (text: string) => /([A-Z2-9]{4})-([A-Z2-9]{4})/.exec(text)

async function setup(t: TestContext) {
  let clock = Math.floor(Date.now() / 1000)
  const pi = new FakeEngine('pi')
  const h = await FeishuFakeHarness.start(t, {
    upstreams: { pi },
    now: () => clock,
    wakeTickMs: 10,
    outboxTickMs: 10,
    extensions: ['litchReviews'],
  })
  h.fake.addApp({ appId: APP })
  h.fake.users.set(CAROL, { name: '示例用户丙', unionId: 'on_carol' })
  h.fake.users.set(DAVE, { name: '示例用户丁' })
  h.fake.addChat({
    chatId: GATED,
    name: '示例审批群',
    bots: new Set([APP]),
    members: [
      { openId: CAROL, name: '示例用户丙' },
      { openId: DAVE, name: '示例用户丁' },
    ],
  })
  await h.configure(APP)
  await h.until(async () => (await h.admin.call(M.chatList, { appId: APP })).chats.length === 1)
  const client = h.env.connect()
  await client.initialize(['harness', 'litchManager'])
  t.after(() => client.close())
  const { manager, threadId } = await client.call(MANAGER_METHOD.create, {
    cwd: h.env.stateDir,
    harness: 'pi',
    model: null,
    effort: null,
    name: '经理',
    scope: '测试',
    template: 'blank',
    dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false },
    contact: { ...MANAGER_DEFAULT_CONTACT },
    rules: '',
    firstTask: '',
  })
  await until(() => pi.running(threadId), '经理第一个回合')
  const current = (await h.admin.call(M.appGet, { appId: APP })).app
  await h.admin.call(M.appUpdate, {
    appId: APP,
    expectedRevision: current.revision,
    managerId: manager.id,
  })
  const chat = (await h.admin.call(M.chatGet, { appId: APP, chatId: GATED })).chat
  await h.admin.call(M.chatAccess, {
    appId: APP,
    chatId: GATED,
    expectedRevision: chat.revision,
    speech: 'approval',
    wakeBound: true,
    wakers: [],
    retentionDays: 90,
    reviewTtlHours: 2,
  })
  const feishu = h.env.device.feishu
  assert.ok(feishu)
  await feishu.records.idle()
  const dm = async (openId: string, text: string) => {
    const message = h.fake.postMessage({
      chatId: p2p(openId),
      sender: openId,
      text,
      chatType: 'p2p',
    })
    await h.fake.push(APP, 'im.message.receive_v1', h.fake.receiveEvent(message))
    await feishu.bindings.idle()
    return message
  }
  const botSaid = (openId: string) =>
    h.fake.messages
      .filter((one) => one.chat_id === p2p(openId) && one.sender.sender_type === 'app')
      .map((one) => ({ type: one.msg_type, content: one.content, id: one.message_id }))
  const call = async (tool: string, args: unknown = {}) => {
    const result = await pi.callTool(threadId, FEISHU_TOOLS_NAMESPACE, tool, args)
    assert.ok(result)
    return result.answer
  }
  const bind = async (openId: string) => {
    await dm(openId, '你好')
    const text = JSON.parse(botSaid(openId).at(-1)?.content ?? '{}').text as string
    const code = codeIn(text)
    assert.ok(code, '回了配对码')
    return (await h.admin.call(M.bindingApprove, { appId: APP, code: `${code[1]}${code[2]}` }))
      .binding
  }
  return {
    h,
    pi,
    feishu,
    manager,
    threadId,
    dm,
    botSaid,
    call,
    bind,
    advance: (seconds: number) => {
      clock += seconds
    },
  }
}

test('配对：没绑定的私聊只回配对码、不落库，限流；按码确认后绑定并回“已绑定”', async (t) => {
  const { h, feishu, dm, botSaid, advance } = await setup(t)
  const first = await dm(CAROL, '我想找经理')
  assert.equal(feishu.messages.get(APP, first.message_id), null, '没绑定的私聊不落库')
  const replies = botSaid(CAROL)
  assert.equal(replies.length, 1)
  const text = JSON.parse(replies[0]?.content ?? '{}').text as string
  const code = codeIn(text)
  assert.ok(code)
  assert.doesNotMatch(`${code[1]}${code[2]}`, /[01ILO]/)
  assert.equal((await h.admin.call(M.appGet, { appId: APP })).app.pendingPairings, 1)

  await dm(CAROL, '还在吗')
  assert.equal(botSaid(CAROL).length, 1, '10 分钟内不重复回')
  advance(601)
  await dm(CAROL, '还在吗')
  assert.equal(botSaid(CAROL).length, 2, '过了 10 分钟再回一次')
  assert.equal(
    codeIn(JSON.parse(botSaid(CAROL)[1]?.content ?? '{}').text)?.[0],
    code[0],
    '同一个码',
  )

  // 读者连接不能查码
  const reader = h.env.connect()
  await reader.initialize(['harness', 'litchFeishu'])
  t.after(() => reader.close())
  const denied = await reader.fails(M.bindingLookup, { appId: APP, code: code[0] })
  assert.equal((denied.data as { litch?: string }).litch, 'deviceAdminRequired')
  const wrong = await h.admin.fails(M.bindingLookup, { appId: APP, code: 'AAAA-AAAA' })
  assert.equal(wrong.message, 'feishu_pairing_not_found')

  const lowered = `${code[1]}${code[2]}`.toLowerCase()
  const { pairing } = await h.admin.call(M.bindingLookup, { appId: APP, code: lowered })
  assert.equal(pairing.openId, CAROL)
  assert.equal(pairing.name, '示例用户丙')
  assert.equal(pairing.unionId, 'on_carol')
  const { binding } = await h.admin.call(M.bindingApprove, { appId: APP, code: code[0] })
  assert.equal(binding.state, 'bound')
  assert.equal(binding.approver, true, '第一个绑定的人默认是审批人')
  assert.equal(binding.name, '示例用户丙')
  await feishu.bindings.idle()
  assert.match(JSON.parse(botSaid(CAROL).at(-1)?.content ?? '{}').text, /已绑定/)
  assert.equal((await h.admin.call(M.appGet, { appId: APP })).app.pendingPairings, undefined)
  const again = await h.admin.fails(M.bindingApprove, { appId: APP, code: code[0] })
  assert.equal(again.message, 'feishu_pairing_not_found', '码用过就失效')
  const listed = (await reader.call(M.bindingList, { appId: APP })).bindings as FeishuBinding[]
  assert.deepEqual(
    listed.map((one) => [one.openId, one.state]),
    [[CAROL, 'bound']],
  )
  const actions = feishu.store.auditEntries(APP).map((one) => one.action)
  assert.ok(actions.includes('pairing_requested') && actions.includes('binding_approved'))

  // 过期：一小时后码作废
  await dm(DAVE, '你好')
  const daveCode = codeIn(JSON.parse(botSaid(DAVE)[0]?.content ?? '{}').text)?.[0] as string
  advance(3601)
  const expired = await h.admin.fails(M.bindingLookup, { appId: APP, code: daveCode })
  assert.equal(expired.message, 'feishu_pairing_not_found')
})

test('配对限量：一个应用最多 20 个待批，超了不回，审计记一次', async (t) => {
  const { h, feishu, dm, botSaid } = await setup(t)
  for (let index = 0; index < 21; index++) await dm(`ou_guest${index}`, '你好')
  assert.equal(botSaid('ou_guest19').length, 1)
  assert.equal(botSaid('ou_guest20').length, 0, '第 21 个不回')
  await dm('ou_guest21', '你好')
  assert.equal(
    feishu.store.auditEntries(APP).filter((one) => one.action === 'pairing_limited').length,
    1,
  )
  assert.equal((await h.admin.call(M.appGet, { appId: APP })).app.pendingPairings, 20)
})

test('私聊：已绑定的人每条都进收件箱叫醒经理，经理回私聊不审批；撤销后和没绑定一样', async (t) => {
  const { h, pi, feishu, manager, threadId, dm, botSaid, call, bind, advance } = await setup(t)
  const binding = await bind(CAROL)
  pi.end(threadId, 'completed', '好')
  const starts = () => pi.sent('turn/start').filter((params) => params.threadId === threadId)
  const before = starts().length
  const message = await dm(CAROL, '帮我看一下进度')
  assert.equal(feishu.messages.get(APP, message.message_id)?.chatKind, 'p2p')
  const [entry] = feishu.inbox.list(manager.id, ['queued', 'notified'])
  assert.equal(entry?.trigger, 'p2p')
  assert.equal(entry?.senderIdentity, 'bound')
  advance(25)
  await until(() => starts().length === before + 1, '送进回合')
  const text = String(starts().at(-1)?.input?.[0]?.text ?? '')
  assert.match(text, /Direct message with 示例用户丙 \(reply with feishu_send user=ou_carol\)/)
  assert.match(text, /direct message · sender bound/)
  assert.match(text, /帮我看一下进度/)

  const chats = resultOf(await call('feishu_chats')) as { users: { openId: string }[] }
  assert.deepEqual(
    chats.users.map((one) => one.openId),
    [CAROL],
  )
  const history = resultOf(await call('feishu_history', { user: '示例用户丙' })) as {
    text: string
  }
  assert.match(history.text, /帮我看一下进度/)
  const sent = resultOf(
    await call('feishu_send', { user: '示例用户丙', text: '在跟进', operationId: 'dm-op-0001' }),
  ) as { state: string }
  assert.notEqual(sent.state, 'awaiting_approval', '私聊不审批')
  await until(() => feishu.outbox.get('dm-op-0001')?.state === 'sent', '私聊发出')
  assert.ok(botSaid(CAROL).some((one) => one.content.includes('在跟进')))
  assert.equal(
    failureOf(await call('feishu_send', { user: DAVE, text: '你好' })),
    'invalid',
    '没绑定的人发不了',
  )

  // 撤销：再私聊就又是配对
  const revoked = (
    await h.admin.call(M.bindingRevoke, {
      appId: APP,
      openId: CAROL,
      expectedRevision: binding.revision,
    })
  ).binding
  assert.equal(revoked.state, 'revoked')
  const after = await dm(CAROL, '还在吗')
  assert.equal(feishu.messages.get(APP, after.message_id), null)
  assert.ok(codeIn(JSON.parse(botSaid(CAROL).at(-1)?.content ?? '{}').text))
  const conflict = await h.admin.fails(M.bindingUpdate, {
    appId: APP,
    openId: CAROL,
    expectedRevision: binding.revision,
    approver: true,
  })
  assert.equal(conflict.message, 'feishu_revision_conflict')
})

test('飞书卡片审批：审批人收卡片、点按钮批准后原样发出；非审批人和过时的卡片被拒；在 Litch 里批的卡片也改', async (t) => {
  const { h, feishu, botSaid, call, bind } = await setup(t)
  const carol = await bind(CAROL)
  const dave = await bind(DAVE)
  assert.equal(dave.approver, false, '第二个绑定的不是审批人')
  const send = async (operationId: string, text: string) =>
    (
      resultOf(await call('feishu_send', { chat: GATED, text, operationId })) as {
        review: { reviewId: string }
      }
    ).review

  const first = await send('card-op-1', '本周进度：完成了两项')
  await feishu.cards?.idle()
  const cards = botSaid(CAROL).filter((one) => one.type === 'interactive')
  assert.equal(cards.length, 1, '审批人收到一张卡片')
  assert.equal(botSaid(DAVE).filter((one) => one.type === 'interactive').length, 0)
  const card = JSON.parse(cards[0]?.content ?? '{}')
  assert.equal(card.config.update_multi, true)
  assert.match(JSON.stringify(card), /本周进度/)
  const value = (decision: string, revision = 1) => ({
    litch: 'review',
    reviewId: first.reviewId,
    revision,
    decision,
  })
  const click = (openId: string, decision: string, revision = 1) =>
    h.fake.push(APP, 'card.action.trigger', {
      operator: { open_id: openId },
      token: 'tok',
      action: { tag: 'button', value: value(decision, revision) },
      context: { open_message_id: cards[0]?.id, open_chat_id: p2p(openId) },
    })

  const notApprover = (await click(DAVE, 'approve')).data as { toast: { type: string } }
  assert.equal(notApprover.toast.type, 'error')
  const stale = (await click(CAROL, 'approve', 7)).data as { toast: { type: string } }
  assert.equal(stale.toast.type, 'error')
  assert.equal((await h.admin.call(R.get, { reviewId: first.reviewId })).review.state, 'pending')

  const ack = (await click(CAROL, 'approve')).data as {
    toast: { type: string }
    card: { type: string; data: Record<string, unknown> }
  }
  assert.equal(ack.toast.type, 'success')
  assert.match(JSON.stringify(ack.card.data), /已批准/)
  const review = (await h.admin.call(R.get, { reviewId: first.reviewId })).review
  assert.equal(review.state, 'approved')
  assert.deepEqual(review.decidedBy, { via: 'feishu', who: CAROL })
  await until(() => feishu.outbox.get('card-op-1')?.state === 'sent', '批准后发出')
  await feishu.cards?.idle()
  const patched = h.fake.messages.find((one) => one.message_id === cards[0]?.id)
  assert.match(patched?.content ?? '', /已批准/)
  assert.match(patched?.content ?? '', /示例用户丙/)
  const again = (await click(CAROL, 'reject')).data as { toast: { type: string } }
  assert.equal(again.toast.type, 'error', '已有结果的不能再批')

  // 在 Litch 里批：卡片跟着改
  const second = await send('card-op-2', '第二条')
  await feishu.cards?.idle()
  const secondCard = botSaid(CAROL)
    .filter((one) => one.type === 'interactive')
    .at(-1)
  const pending = (await h.admin.call(R.get, { reviewId: second.reviewId })).review
  await h.admin.call(R.decide, {
    reviewId: second.reviewId,
    decision: 'reject',
    reason: '先不发',
    expectedRevision: pending.revision,
  })
  await feishu.cards?.idle()
  const rejected = h.fake.messages.find((one) => one.message_id === secondCard?.id)
  assert.match(rejected?.content ?? '', /已拒绝/)
  assert.match(rejected?.content ?? '', /在 Litch 里/)
  assert.match(rejected?.content ?? '', /先不发/)

  // 取消审批人：不再收卡片
  await h.admin.call(M.bindingUpdate, {
    appId: APP,
    openId: CAROL,
    expectedRevision: carol.revision,
    approver: false,
    retentionDays: 30,
  })
  const count = botSaid(CAROL).filter((one) => one.type === 'interactive').length
  await send('card-op-3', '第三条')
  await feishu.cards?.idle()
  assert.equal(botSaid(CAROL).filter((one) => one.type === 'interactive').length, count)
  const listed = (await h.admin.call(M.bindingList, { appId: APP })).bindings as FeishuBinding[]
  assert.deepEqual(
    listed.find((one) => one.openId === CAROL),
    { ...listed.find((one) => one.openId === CAROL), approver: false, retentionDays: 30 },
  )
})

test('批准后发送失败：审批记下原因，卡片改成“已批准 · 发送失败”，经理在下一次投递时得知', async (t) => {
  const { h, feishu, botSaid, call, bind, manager } = await setup(t)
  await bind(CAROL)
  const { review } = resultOf(
    await call('feishu_send', { chat: GATED, text: '今晚发布', operationId: 'fail-op-1' }),
  ) as { review: { reviewId: string } }
  await feishu.cards?.idle()
  const card = botSaid(CAROL)
    .filter((one) => one.type === 'interactive')
    .at(-1)
  const announced = () =>
    h.admin.notifications.filter(
      (frame) =>
        frame.method === 'litch/reviews/changed' &&
        (frame.params as { reviewId?: string }).reviewId === review.reviewId,
    ).length
  // 飞书拒绝这次发送（群不存在一类的错误）
  h.fake.sendFaults.push({ kind: 'error', code: 230002 })
  const pending = (await h.admin.call(R.get, { reviewId: review.reviewId })).review
  const before = announced()
  await h.admin.call(R.decide, {
    reviewId: review.reviewId,
    decision: 'approve',
    expectedRevision: pending.revision,
  })
  await until(() => feishu.outbox.get('fail-op-1')?.state === 'failed', '发送失败')
  const failed = (await h.admin.call(R.get, { reviewId: review.reviewId })).review
  assert.equal(failed.state, 'approved')
  assert.equal(failed.revision, pending.revision + 2)
  assert.equal(failed.execution?.state, 'failed')
  assert.equal(failed.execution?.error, 'not_found')
  assert.ok(announced() >= before + 2, '批准和发送失败各通知一次')
  await feishu.cards?.idle()
  const patched = h.fake.messages.find((one) => one.message_id === card?.id)
  assert.match(patched?.content ?? '', /已批准 · 发送失败/)
  assert.match(patched?.content ?? '', /目标在飞书上不存在/)
  // 经理照旧在下一次飞书投递时得知（不单独叫醒）
  assert.equal(feishu.outbox.unreported(manager.id).length, 1)
})
