// F5：发言与审批。真实 SDK 连回环上的假飞书，经理跑在假引擎上，用 litch_feishu.feishu_send 发言：
// 自由发言直接发（@ 按成员表解析、手写 <at> 打断、长文分片、表格用卡片、uuid、发出的记进消息库）；
// 审批发言先冻结、建审批（litchReviews），批了原样发、拒了和过期的结果随下次投递告诉经理；
// 结果不明一小时内带同一 uuid 重发；图片上传；载荷被改就不发。
import assert from 'node:assert/strict'
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { FEISHU_TOOLS_NAMESPACE } from '../../protocol/src/client-tools-feishu.mjs'
import { FEISHU_NOTIFICATION, FEISHU_METHOD as M } from '../../protocol/src/feishu.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { REVIEWS_METHOD as R, REVIEWS_NOTIFICATION } from '../../protocol/src/reviews.mjs'
import { FakeEngine, failureOf, resultOf } from './fake-engine.mjs'
import { FeishuFakeHarness } from './feishu-harness.mjs'
import { until } from './tree-kit.mjs'

const APP = 'cli_0123456789abcdef'
const TEAM = 'oc_team'
const GATED = 'oc_gated'
const ALICE = 'ou_alice'
const BOB = 'ou_bob'
const BOB2 = 'ou_bob2'

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
  const app = h.fake.addApp({ appId: APP })
  const members = [
    { openId: ALICE, name: '示例成员甲' },
    { openId: BOB, name: '示例成员乙' },
  ]
  h.fake.addChat({ chatId: TEAM, name: '示例项目群', bots: new Set([APP]), members })
  h.fake.addChat({
    chatId: GATED,
    name: '示例审批群',
    bots: new Set([APP]),
    members: [...members, { openId: BOB2, name: '示例成员乙' }],
  })
  await h.configure(APP)
  await h.until(async () => (await h.admin.call(M.chatList, { appId: APP })).chats.length === 2)

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
  for (const [chatId, speech] of [
    [TEAM, 'free'],
    [GATED, 'approval'],
  ] as const) {
    const chat = (await h.admin.call(M.chatGet, { appId: APP, chatId })).chat
    await h.admin.call(M.chatAccess, {
      appId: APP,
      chatId,
      expectedRevision: chat.revision,
      speech,
      wakeBound: true,
      wakers: [ALICE],
      retentionDays: 90,
      reviewTtlHours: 2,
    })
  }
  const feishu = h.env.device.feishu
  assert.ok(feishu)
  await feishu.records.idle()
  const call = async (tool: string, args: unknown = {}) => {
    const result = await pi.callTool(threadId, FEISHU_TOOLS_NAMESPACE, tool, args)
    assert.ok(result)
    return result.answer
  }
  const send = async (args: Record<string, unknown>) => resultOf(await call('feishu_send', args))
  const sentTo = (chatId: string) =>
    h.fake.sent.filter((one) => {
      const message = h.fake.messages.find((item) => item.message_id === one.messageId)
      return message?.chat_id === chatId
    })
  return {
    h,
    pi,
    app,
    feishu,
    manager,
    threadId,
    call,
    send,
    sentTo,
    advance: (seconds: number) => {
      clock += seconds
    },
  }
}

test('自由发言：@ 按成员表解析、手写 <at> 打断、uuid、发出的消息记进库，回复它能叫醒', async (t) => {
  const { h, feishu, manager, send, call, sentTo } = await setup(t)
  const changed = h.admin.waitFor(
    (frame) => (frame as { method?: string }).method === FEISHU_NOTIFICATION.outboxChanged,
  )

  const refused = await call('feishu_send', {
    chat: TEAM,
    text: '找人',
    mentions: ['不在群里的人'],
  })
  assert.equal(failureOf(refused), 'invalid')
  assert.equal(sentTo(TEAM).length, 0)

  const result = await send({
    chat: '示例项目群',
    text: '测试发言 <at user_id="all">所有人</at>',
    mentions: ['示例成员甲', BOB],
    operationId: 'send-op-free-1',
  })
  assert.equal(result.operationId, 'send-op-free-1')
  assert.equal(result.format, 'post')
  await changed
  await until(() => feishu.outbox.get('send-op-free-1')?.state === 'sent', '发出')
  const [request] = sentTo(TEAM)
  assert.ok(request)
  assert.equal(request.uuid, 'send-op-free-1-0')
  assert.equal(request.query.receive_id_type, 'chat_id')
  assert.equal(request.body.msg_type, 'post')
  const post = JSON.parse(String(request.body.content)) as {
    zh_cn: { content: Record<string, string>[][] }
  }
  const paragraph = post.zh_cn.content[0] ?? []
  assert.deepEqual(
    paragraph.filter((one) => one.tag === 'at').map((one) => one.user_id),
    [ALICE, BOB],
  )
  const md = paragraph.find((one) => one.tag === 'md')?.text ?? ''
  assert.ok(!/<at\b/i.test(md), '手写的 <at> 被打断')

  // 同一个操作 ID 再调一次：返回原结果，不再发
  const again = await send({ chat: TEAM, text: '换了内容', operationId: 'send-op-free-1' })
  assert.equal(again.state, 'sent')
  assert.equal(sentTo(TEAM).length, 1)

  // 发出去的消息按 source=sent 记下；有人回复它，本地判定为“回复机器人”
  const record = feishu.outbox.get('send-op-free-1')
  const sentId = record?.messageIds[0] as string
  assert.equal(feishu.messages.get(APP, sentId)?.source, 'sent')
  const fetches = h.fake.calls.filter((one) => one.method === 'GET' && one.path.endsWith(sentId))
  const reply = h.fake.postMessage({ chatId: TEAM, sender: ALICE, text: '收到', parentId: sentId })
  await h.fake.push(APP, 'im.message.receive_v1', h.fake.receiveEvent(reply))
  await until(() => feishu.inbox.list(manager.id, ['queued']).length === 1, '回复进收件箱')
  assert.equal(
    h.fake.calls.filter((one) => one.method === 'GET' && one.path.endsWith(sentId)).length,
    fetches.length,
    '不用回源',
  )

  // 状态查询与撤下已发出的（不撤回飞书上的）
  const got = resultOf(await call('feishu_send_get', { operationId: 'send-op-free-1' }))
  assert.deepEqual(got.messageIds, [sentId])
  const kept = resultOf(await call('feishu_send_cancel', { operationId: 'send-op-free-1' }))
  assert.equal(kept.state, 'sent')
})

test('长文分片、表格用卡片、回复与回退直接发、图片上传', async (t) => {
  const { h, feishu, send, sentTo, pi, threadId } = await setup(t)
  const long = Array.from({ length: 3 }, (_, index) => `第 ${index} 段 ${'字'.repeat(3000)}`).join(
    '\n\n',
  )
  const split = await send({ chat: TEAM, text: long, format: 'text', operationId: 'send-op-long' })
  assert.equal(split.parts, 3)
  await until(() => feishu.outbox.get('send-op-long')?.state === 'sent', '分片发完')
  assert.deepEqual(
    sentTo(TEAM).map((one) => one.uuid),
    ['send-op-long-0', 'send-op-long-1', 'send-op-long-2'],
  )

  const table = await send({
    chat: TEAM,
    text: '| 列 | 值 |\n| --- | --- |\n| a | 1 |',
    operationId: 'send-op-card',
  })
  assert.equal(table.format, 'card')
  await until(() => feishu.outbox.get('send-op-card')?.state === 'sent', '卡片发出')
  assert.equal(sentTo(TEAM).at(-1)?.body.msg_type, 'interactive')

  // 回复一条记过的消息；回复对象在飞书上没了就改成直接发
  const parent = h.fake.postMessage({ chatId: TEAM, sender: ALICE, text: '原话' })
  await h.fake.push(APP, 'im.message.receive_v1', h.fake.receiveEvent(parent))
  await until(() => feishu.messages.get(APP, parent.message_id) !== null, '记下原话')
  await send({ chat: TEAM, text: '回你', replyTo: parent.message_id, operationId: 'send-op-reply' })
  await until(() => feishu.outbox.get('send-op-reply')?.state === 'sent', '回复发出')
  assert.match(sentTo(TEAM).at(-1)?.path ?? '', /\/reply$/)
  h.fake.messages.splice(h.fake.messages.indexOf(parent), 1)
  await send({
    chat: TEAM,
    text: '再回',
    replyTo: parent.message_id,
    operationId: 'send-op-fallback',
  })
  await until(() => feishu.outbox.get('send-op-fallback')?.state === 'sent', '回退直接发')
  assert.equal(sentTo(TEAM).at(-1)?.path, '/open-apis/im/v1/messages')

  // 图片：调用时复制一份冻结，发送时上传
  const image = join(h.env.stateDir, 'shot.png')
  writeFileSync(image, Buffer.from('fake png bytes'))
  pi.end(threadId, 'completed', '好')
  const shot = await send({ chat: TEAM, imagePath: image, operationId: 'send-op-image' })
  assert.equal(shot.format, 'image')
  await until(() => feishu.outbox.get('send-op-image')?.state === 'sent', '图片发出')
  const imageKey = JSON.parse(String(sentTo(TEAM).at(-1)?.body.content)).image_key
  assert.equal(h.fake.uploads.get(imageKey)?.kind, 'image')
  assert.deepEqual(readdirSync(join(h.env.stateDir, 'feishu-outbox')), [], '发完删掉冻结的载荷')
})

test('审批发言：冻结后建审批，批了原样发；没声明扩展的连接看不到、只读连接不能批；被改的载荷不发', async (t) => {
  const { h, feishu, send, call, sentTo } = await setup(t)
  const ambiguous = await call('feishu_send', {
    chat: GATED,
    text: '找乙',
    mentions: ['示例成员乙'],
  })
  assert.match(ambiguous.result.contentItems[0].text, /Several members are named/, '重名不猜')

  const reviewed = h.admin.waitFor(
    (frame) => (frame as { method?: string }).method === REVIEWS_NOTIFICATION.changed,
  )
  const result = await send({
    chat: GATED,
    text: '要审批的测试发言',
    mentions: [ALICE],
    operationId: 'send-op-gated-1',
  })
  assert.equal(result.state, 'awaiting_approval')
  assert.match(result.review.reviewId, /^A-\d+$/)
  await reviewed
  assert.equal(sentTo(GATED).length, 0)

  const { reviews } = await h.admin.call(R.list, { states: ['pending'] })
  assert.equal(reviews.length, 1)
  const [review] = reviews
  assert.equal(review.subjectRef, 'send-op-gated-1')
  assert.equal(review.preview.target.name, '示例审批群')
  assert.deepEqual(review.preview.mentions, [{ openId: ALICE, name: '示例成员甲' }])
  assert.match(review.preview.parts[0].text, /^@示例成员甲 要审批的测试发言/)

  // 没声明 litchReviews 的连接调不了；不是设备管理员的连接只能读
  const plain = h.env.connect()
  await plain.initialize(['harness'])
  t.after(() => plain.close())
  assert.equal(
    ((await plain.fails(R.list, {})).data as { litch?: string }).litch,
    'extensionRequired',
  )
  const reader = h.env.connect()
  await reader.initialize(['harness', 'litchReviews'])
  t.after(() => reader.close())
  assert.equal((await reader.call(R.get, { reviewId: review.reviewId })).review.state, 'pending')
  const denied = await reader.fails(R.decide, {
    reviewId: review.reviewId,
    decision: 'approve',
    expectedRevision: review.revision,
  })
  assert.equal((denied.data as { litch?: string }).litch, 'deviceAdminRequired')

  const approved = await h.admin.call(R.decide, {
    reviewId: review.reviewId,
    decision: 'approve',
    expectedRevision: review.revision,
  })
  assert.equal(approved.review.state, 'approved')
  assert.deepEqual(approved.review.decidedBy, { via: 'litch' })
  await until(() => feishu.outbox.get('send-op-gated-1')?.state === 'sent', '批了发出')
  assert.equal(sentTo(GATED)[0]?.uuid, 'send-op-gated-1-0')
  const conflict = await h.admin.fails(R.decide, {
    reviewId: review.reviewId,
    decision: 'reject',
    expectedRevision: approved.review.revision,
  })
  assert.equal(conflict.message, 'review_not_pending')

  // 批之前载荷被改：哈希对不上，不发
  await send({ chat: GATED, text: '第二条', operationId: 'send-op-gated-2' })
  const second = feishu.outbox.get('send-op-gated-2')
  const folder = join(h.env.stateDir, 'feishu-outbox', 'send-op-gated-2')
  writeFileSync(join(folder, 'payload.json'), '{"parts":[]}')
  const pending = (await h.admin.call(R.get, { reviewId: second?.reviewId })).review
  await h.admin.call(R.decide, {
    reviewId: pending.reviewId,
    decision: 'approve',
    expectedRevision: pending.revision,
  })
  await until(() => feishu.outbox.get('send-op-gated-2')?.state === 'failed', '不发')
  assert.equal(feishu.outbox.get('send-op-gated-2')?.error, 'payload_changed')
  assert.equal(sentTo(GATED).length, 1)
})

test('被拒、过期、撤下：不发；被拒和过期的结果随下一次投递告诉经理一次', async (t) => {
  const { h, pi, feishu, threadId, send, call, sentTo, advance } = await setup(t)
  await send({ chat: GATED, text: '会被拒', operationId: 'send-op-reject' })
  await send({ chat: GATED, text: '会过期', operationId: 'send-op-expire' })
  await send({ chat: GATED, text: '会撤下', operationId: 'send-op-cancel' })

  const rejectId = feishu.outbox.get('send-op-reject')?.reviewId as string
  const rejecting = (await h.admin.call(R.get, { reviewId: rejectId })).review
  const rejected = await h.admin.call(R.decide, {
    reviewId: rejectId,
    decision: 'reject',
    reason: '措辞不对',
    expectedRevision: rejecting.revision,
  })
  assert.equal(rejected.review.reason, '措辞不对')
  assert.equal(feishu.outbox.get('send-op-reject')?.state, 'rejected')

  const canceled = resultOf(await call('feishu_send_cancel', { operationId: 'send-op-cancel' }))
  assert.equal(canceled.state, 'canceled')
  const cancelReview = feishu.outbox.get('send-op-cancel')?.reviewId as string
  assert.equal((await h.admin.call(R.get, { reviewId: cancelReview })).review.state, 'canceled')

  advance(2 * 3600 + 1)
  await until(() => feishu.outbox.get('send-op-expire')?.state === 'canceled', '过期收掉')
  assert.equal(feishu.outbox.get('send-op-expire')?.error, 'review_expired')
  assert.equal(sentTo(GATED).length, 0)

  // 下一次投递带上被拒和过期的结果（撤下是经理自己做的，不再提）
  pi.end(threadId, 'completed', '好')
  const starts = () => pi.sent('turn/start').filter((params) => params.threadId === threadId)
  const before = starts().length
  const app = feishu.appForManager(feishu.outbox.get('send-op-reject')?.managerId as string)
  const asking = h.fake.postMessage({
    chatId: TEAM,
    sender: ALICE,
    text: '@_user_1 结果呢',
    mentions: [{ openId: app?.botOpenId as string, name: '测试机器人' }],
  })
  await h.fake.push(APP, 'im.message.receive_v1', h.fake.receiveEvent(asking))
  advance(25)
  await until(() => starts().length === before + 1, '送进回合')
  const text = String(starts().at(-1)?.input?.[0]?.text ?? '')
  assert.match(text, /send-op-reject to 示例审批群: rejected \(review_rejected\)/)
  assert.match(text, /send-op-expire to 示例审批群: canceled \(review_expired\)/)
  assert.doesNotMatch(text, /op-cancel/)
  assert.deepEqual(feishu.outbox.unreported(app?.managerId as string), [])
})

test('结果不明：一小时内带同一 uuid 重发、飞书去重；超过一小时停下；平台拒绝直接失败', async (t) => {
  const { h, feishu, send, sentTo, advance } = await setup(t)
  h.fake.sendFaults.push({ kind: 'drop' })
  await send({ chat: TEAM, text: '可能发出了', operationId: 'send-op-drop' })
  await until(() => feishu.outbox.get('send-op-drop')?.state === 'unknown', '结果不明')
  const unknown = feishu.outbox.get('send-op-drop')
  assert.ok(unknown?.nextAttemptAt)
  assert.equal(h.fake.messages.filter((one) => one.chat_id === TEAM).length, 1, '其实发出了')
  advance(31)
  await until(() => feishu.outbox.get('send-op-drop')?.state === 'sent', '重发后确认')
  assert.equal(h.fake.messages.filter((one) => one.chat_id === TEAM).length, 1, '飞书按 uuid 去重')
  assert.equal(feishu.outbox.get('send-op-drop')?.messageIds[0], sentTo(TEAM)[0]?.messageId)

  // 一直不明：超过一小时停下，等人核对
  for (let index = 0; index < 12; index++) h.fake.sendFaults.push({ kind: 'reset' })
  await send({ chat: TEAM, text: '一直不明', operationId: 'send-op-lost' })
  for (let round = 0; round < 12; round++) {
    await until(() => feishu.outbox.get('send-op-lost')?.state === 'unknown', '不明')
    if (feishu.outbox.get('send-op-lost')?.nextAttemptAt === undefined) break
    advance(600)
    await until(
      () =>
        (feishu.outbox.get('send-op-lost')?.attempts ?? 0) > round + 1 ||
        feishu.outbox.get('send-op-lost')?.nextAttemptAt === undefined,
      '下一次尝试',
    )
  }
  const lost = feishu.outbox.get('send-op-lost')
  assert.equal(lost?.state, 'unknown')
  assert.equal(lost?.error, 'unknown_timeout')
  assert.equal(lost?.nextAttemptAt, undefined)
  h.fake.sendFaults.length = 0

  h.fake.sendFaults.push({ kind: 'error', code: 230002, status: 400 })
  await send({ chat: TEAM, text: '机器人不在群里', operationId: 'send-op-denied' })
  await until(() => feishu.outbox.get('send-op-denied')?.state === 'failed', '直接失败')
  assert.equal(feishu.outbox.get('send-op-denied')?.error, 'not_found')
})
