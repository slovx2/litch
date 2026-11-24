// F4：收件箱与叫醒。真实 SDK 连回环上的假飞书，经理跑在假引擎上：
// 谁 @ 了机器人、回复了机器人才进收件箱；攒批 20 秒/60 秒；经理在跑回合时留队；投递只带上次之后的新消息；
// 限额顺延；经理工具 litch_feishu；无人值守算上飞书。
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import test, { type TestContext } from 'node:test'
import { FEISHU_TOOLS_NAMESPACE } from '../../protocol/src/client-tools-feishu.mjs'
import { FEISHU_NOTIFICATION, FEISHU_METHOD as M } from '../../protocol/src/feishu.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import { FakeEngine, resultOf } from './fake-engine.mjs'
import type { FakeMessage } from './feishu-fake.mjs'
import { FeishuFakeHarness } from './feishu-harness.mjs'
import { until } from './tree-kit.mjs'

const APP = 'cli_0123456789abcdef'
const TEAM = 'oc_team'
const ALICE = 'ou_alice'
const BOB = 'ou_bob'

async function setup(t: TestContext) {
  let clock = Math.floor(Date.now() / 1000)
  const pi = new FakeEngine('pi')
  const h = await FeishuFakeHarness.start(t, {
    upstreams: { pi },
    now: () => clock,
    wakeTickMs: 10,
  })
  const app = h.fake.addApp({ appId: APP })
  h.fake.addChat({
    chatId: TEAM,
    name: '示例项目群',
    bots: new Set([APP]),
    members: [
      { openId: ALICE, name: '示例成员甲' },
      { openId: BOB, name: '示例成员乙' },
    ],
  })
  // 接入前的旧消息：只补进历史，不算“新消息”
  h.fake.postMessage({
    chatId: TEAM,
    sender: ALICE,
    text: '接入前的旧话',
    at: Date.now() - 3_600_000,
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
  const chat = (await h.admin.call(M.chatGet, { appId: APP, chatId: TEAM })).chat
  await h.admin.call(M.chatAccess, {
    appId: APP,
    chatId: TEAM,
    expectedRevision: chat.revision,
    speech: 'free',
    wakeBound: true,
    wakers: [ALICE],
    retentionDays: 90,
    reviewTtlHours: 24,
  })
  const feishu = h.env.device.feishu
  assert.ok(feishu)
  await feishu.records.idle()
  const say = async (input: Parameters<typeof h.fake.postMessage>[0]) => {
    const message = h.fake.postMessage(input)
    await h.fake.push(APP, 'im.message.receive_v1', h.fake.receiveEvent(message))
    return message
  }
  const mention = { openId: app.botOpenId, name: '测试机器人' }
  const turnStarts = () => pi.sent('turn/start').filter((params) => params.threadId === threadId)
  return {
    h,
    pi,
    app,
    feishu,
    manager,
    threadId,
    say,
    mention,
    turnStarts,
    advance: (seconds: number) => {
      clock += seconds
    },
  }
}

test('找机器人才进收件箱：@ 或回复机器人、发送人在叫醒名单里；回复对象本地没有时回源再判', async (t) => {
  const { h, app, feishu, manager, say, mention } = await setup(t)
  const inbox = () => feishu.inbox.list(manager.id, ['queued', 'notified', 'processed'])

  const asked = await say({
    chatId: TEAM,
    sender: ALICE,
    text: '@_user_1 看一下',
    mentions: [mention],
  })
  await say({ chatId: TEAM, sender: BOB, text: '@_user_1 我也要', mentions: [mention] })
  await say({ chatId: TEAM, sender: ALICE, text: '随便聊聊' })
  await say({
    chatId: TEAM,
    sender: ALICE,
    text: '@_user_1 不是机器人',
    mentions: [{ openId: BOB, name: '示例成员乙' }],
  })
  assert.deepEqual(
    inbox().map((entry) => [entry.messageId, entry.trigger, entry.senderIdentity, entry.status]),
    [[asked.message_id, 'mention', 'member', 'queued']],
  )

  // 回复机器人发的消息：那条本地没有（机器人发言在 F5 之前不落库），回源读到后判定
  const bot: FakeMessage = {
    ...h.fake.postMessage({ chatId: TEAM, sender: ALICE, text: '机器人说的' }),
    sender: { id: APP, id_type: 'app_id', sender_type: 'app', tenant_key: 'tenant-fake' },
  }
  h.fake.messages.splice(h.fake.messages.length - 1, 1, bot)
  const reply = await say({ chatId: TEAM, sender: ALICE, text: '好的', parentId: bot.message_id })
  await h.until(() => inbox().some((entry) => entry.messageId === reply.message_id))
  assert.equal(inbox().find((entry) => entry.messageId === reply.message_id)?.trigger, 'reply')
  // 回复的是普通人的消息：不算
  const plain = await say({ chatId: TEAM, sender: ALICE, text: '回你', parentId: asked.message_id })
  await feishu.records.idle()
  assert.ok(!inbox().some((entry) => entry.messageId === plain.message_id))
  // 进了收件箱的消息过保留期只清正文
  assert.equal(feishu.messages.get(APP, asked.message_id)?.pinned, true)

  // 界面读：列表带消息、单条读取
  const page = await h.admin.call(M.inboxList, { managerId: manager.id, limit: 1 })
  assert.equal(page.entries.length, 1)
  assert.ok(page.next)
  const first = page.entries[0]
  assert.ok(first)
  assert.equal(page.messages[first.inboxId]?.chatName, '示例项目群')
  const one = await h.admin.call(M.inboxGet, { inboxId: first.inboxId })
  assert.equal(one.entry.inboxId, first.inboxId)
  void app
})

test('攒批与投递：经理在跑回合时留队；静默 20 秒后送一组；只带接入后、上次之后的新消息；游标推进', async (t) => {
  const { h, pi, feishu, manager, threadId, say, mention, turnStarts, advance } = await setup(t)
  const notes = () =>
    h.admin.notifications.filter((frame) => frame.method === FEISHU_NOTIFICATION.inboxChanged)
  const before = turnStarts().length

  await say({ chatId: TEAM, sender: BOB, text: '先说一句背景' })
  const asked = await say({
    chatId: TEAM,
    sender: ALICE,
    text: '@_user_1 帮忙看 <b>这个</b>',
    mentions: [mention],
  })
  advance(5)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(turnStarts().length, before, '还没静默够 20 秒')
  advance(30)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(turnStarts().length, before, '经理在跑回合：留队')
  assert.equal(feishu.inbox.list(manager.id, ['queued']).length, 1)

  pi.end(threadId, 'completed', '好')
  await until(() => turnStarts().length === before + 1, '空下来后送进新回合')
  const text = String(turnStarts().at(-1)?.input?.[0]?.text ?? '')
  const event = parseSessionEvent(text).event
  assert.equal(event?.kind, 'manager-feishu')
  assert.match(event?.manager?.text ?? '', /示例项目群 1/)
  assert.match(text, /<litch-external-data source="feishu">/)
  assert.match(text, /先说一句背景/)
  assert.match(text, /@测试机器人 帮忙看 &lt;b&gt;这个&lt;\/b&gt;/)
  assert.match(text, /\[FI-1 · mentioned the bot · sender member\]/)
  assert.doesNotMatch(text, /接入前的旧话/)
  // 会话事件的 JSON 注释里不重复正文
  assert.equal(text.split('先说一句背景').length, 2)
  await until(
    () => feishu.inbox.list(manager.id, ['notified'])[0]?.messageId === asked.message_id,
    '标记已送达',
  )
  assert.ok(notes().length > 0)

  // 第二批只带游标之后的
  pi.end(threadId, 'completed', '处理了')
  await say({ chatId: TEAM, sender: ALICE, text: '@_user_1 还有一件', mentions: [mention] })
  advance(25)
  await until(() => turnStarts().length === before + 2, '第二批')
  const second = String(turnStarts().at(-1)?.input?.[0]?.text ?? '')
  assert.match(second, /还有一件/)
  assert.doesNotMatch(second, /先说一句背景/)
  assert.match(second, /FI-2/)
})

test('限额：15 分钟内叫满 10 次后顺延，收件箱标限额中', async (t) => {
  const { feishu, manager, threadId, pi, say, mention, turnStarts, advance } = await setup(t)
  pi.end(threadId, 'completed', '好')
  await until(() => !pi.running(threadId), '经理空闲')
  const db = feishu.store.managers.db
  const now = feishu.now()
  for (let index = 0; index < 10; index++)
    db.prepare('INSERT INTO feishu_deliveries VALUES(?,?,?,?,?)').run(
      `old-${index}`,
      manager.id,
      APP,
      now - 60,
      JSON.stringify({ state: 'confirmed', inboxIds: [] }),
    )
  const before = turnStarts().length
  await say({ chatId: TEAM, sender: ALICE, text: '@_user_1 在吗', mentions: [mention] })
  advance(25)
  await until(
    () => feishu.inbox.list(manager.id, ['queued'])[0]?.note === 'rate_limited',
    '标限额中',
  )
  assert.equal(turnStarts().length, before)
  advance(900)
  await until(() => turnStarts().length === before + 1, '下一个窗口送出')
})

test('经理工具：列收件箱、标处理完、查群和成员、查历史、下载附件、记引用；无人值守算上飞书', async (t) => {
  const { h, pi, feishu, manager, threadId, say, mention, turnStarts, advance } = await setup(t)
  assert.ok(h.env.device.managers.unattended(threadId), '应用启用且接入了群')
  const bundle = h.env.device.managers.bundle(
    h.env.device.managers.store.manager(manager.id) as never,
  )
  assert.ok(bundle.some((spec) => spec.name === FEISHU_TOOLS_NAMESPACE))

  pi.end(threadId, 'completed', '好')
  const before = turnStarts().length
  h.fake.resources.set('file_report', { bytes: Buffer.from('report body'), type: 'text/plain' })
  const filed = await say({
    chatId: TEAM,
    sender: ALICE,
    msgType: 'file',
    content: JSON.stringify({ file_key: 'file_report', file_name: '../报告.txt' }),
  })
  await say({ chatId: TEAM, sender: ALICE, text: '@_user_1 看看附件', mentions: [mention] })
  advance(25)
  await until(() => turnStarts().length === before + 1, '送进回合')
  const call = async (tool: string, args: unknown = {}) => {
    const result = await pi.callTool(threadId, FEISHU_TOOLS_NAMESPACE, tool, args)
    assert.ok(result)
    return result.answer
  }

  const listed = resultOf(await call('feishu_inbox_list'))
  assert.equal(listed.entries.length, 1)
  assert.match(listed.entries[0].text, /看看附件/)
  const chats = resultOf(await call('feishu_chats'))
  assert.deepEqual(
    chats.chats.map((chat: { chatId: string; speech: string }) => [chat.chatId, chat.speech]),
    [[TEAM, 'free']],
  )
  const members = resultOf(await call('feishu_members', { chat: '示例项目群' }))
  assert.deepEqual(members.members.map((one: { openId: string }) => one.openId).sort(), [
    ALICE,
    BOB,
  ])
  const history = resultOf(await call('feishu_history', { chat: TEAM, keyword: '附件' }))
  assert.equal(history.count, 1)
  assert.match(history.text, /<litch-external-data source="feishu">/)
  const all = resultOf(await call('feishu_history', { chat: TEAM }))
  assert.match(all.text, /fileKey=file_report/)

  const saved = resultOf(
    await call('feishu_attachment', { messageId: filed.message_id, fileKey: 'file_report' }),
  )
  assert.ok(saved.path.startsWith(h.env.stateDir))
  assert.ok(!saved.path.includes('..'))
  assert.equal(statSync(saved.path).mode & 0o777, 0o600)
  const again = resultOf(
    await call('feishu_attachment', { messageId: filed.message_id, fileKey: 'file_report' }),
  )
  assert.equal(again.path, saved.path)
  assert.equal(
    h.fake.calls.filter((one) => one.path.includes('/resources/')).length,
    1,
    '同一附件只下一次',
  )

  const ref = resultOf(
    await call('feishu_message_ref', { messageId: filed.message_id, issueId: 'X-1' }),
  )
  assert.equal(ref.kept, true)
  assert.equal(feishu.messages.get(APP, filed.message_id)?.pinned, true)

  // 不带 ID：标上次列出的那批；之后到的不受影响
  await say({ chatId: TEAM, sender: ALICE, text: '@_user_1 后来的', mentions: [mention] })
  const done = resultOf(await call('feishu_inbox_done'))
  assert.deepEqual(done.processed, [listed.entries[0].inboxId])
  assert.equal(feishu.inbox.list(manager.id, ['queued']).length, 1)

  const missing = await call('feishu_members', { chat: '不存在的群' })
  assert.equal(missing.result.success, false)
})
