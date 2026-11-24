// F3：记录与历史。真实 SDK 连回环上的假飞书：只记已接入的群；接入补 7 天（最多 1000 条、留最新的）；
// 手动补；断线重连补缺口；撤回；成员进退；合并转发、卡片、名片回源；取消接入删或留记录；保留期清理。
import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { FEISHU_METHOD as M } from '../../protocol/src/feishu.mjs'
import { IM_MESSAGES_FILE } from '../src/feishu/messages.mjs'
import { FeishuFakeHarness } from './feishu-harness.mjs'

const APP = 'cli_0123456789abcdef'
const TEAM = 'oc_team'
const OTHER = 'oc_other'
const DAY = 86_400_000

async function setup(t: TestContext) {
  const h = await FeishuFakeHarness.start(t)
  const app = h.fake.addApp({ appId: APP })
  h.fake.addChat({
    chatId: TEAM,
    name: '示例项目群',
    bots: new Set([APP]),
    members: [
      { openId: 'ou_alice', name: '示例成员甲' },
      { openId: 'ou_bob', name: '示例成员乙' },
    ],
  })
  h.fake.addChat({
    chatId: OTHER,
    name: '示例闲聊群',
    bots: new Set([APP]),
    members: [{ openId: 'ou_alice', name: '示例成员甲' }],
  })
  await h.configure(APP)
  await h.until(async () => (await h.admin.call(M.chatList, { appId: APP })).chats.length === 2)
  const feishu = h.env.device.feishu
  assert.ok(feishu)
  return { h, app, feishu, messages: feishu.messages, records: feishu.records }
}

async function access(h: FeishuFakeHarness, chatId: string, retentionDays = 90) {
  const chat = (await h.admin.call(M.chatGet, { appId: APP, chatId })).chat
  return (
    await h.admin.call(M.chatAccess, {
      appId: APP,
      chatId,
      expectedRevision: chat.revision,
      speech: 'free',
      wakeBound: true,
      wakers: [],
      retentionDays,
      reviewTtlHours: 24,
    })
  ).chat
}

const event = (
  h: FeishuFakeHarness,
  message: ReturnType<FeishuFakeHarness['fake']['postMessage']>,
) => h.fake.push(APP, 'im.message.receive_v1', h.fake.receiveEvent(message))

test('只记已接入的群：未接入的丢弃；@ 占位换成名字；撤回清正文；库文件只有属主可读写', async (t) => {
  const { h, app, messages, records } = await setup(t)
  const before = h.fake.postMessage({ chatId: TEAM, sender: 'ou_alice', text: '接入前说的' })
  await event(h, before)
  assert.equal(messages.get(APP, before.message_id), null)
  assert.equal(messages.count(APP, TEAM).messages, 0)

  await access(h, TEAM)
  await records.idle()
  const hello = h.fake.postMessage({
    chatId: TEAM,
    sender: 'ou_alice',
    text: '@_user_1 帮忙看一下',
    mentions: [{ openId: app.botOpenId, name: '测试机器人' }],
  })
  await event(h, hello)
  const stored = messages.get(APP, hello.message_id)
  assert.equal(stored?.text, '@测试机器人 帮忙看一下')
  assert.equal(stored?.source, 'event')
  assert.deepEqual(stored?.mentions, [
    { key: '@_user_1', openId: app.botOpenId, name: '测试机器人' },
  ])
  // 没接入的群照样丢
  await event(h, h.fake.postMessage({ chatId: OTHER, sender: 'ou_alice', text: '旁边群' }))
  assert.equal(messages.count(APP, OTHER).messages, 0)
  // 同一事件重推不重复
  await event(h, hello)
  assert.equal(messages.count(APP, TEAM).messages, 2)

  await h.fake.push(APP, 'im.message.recalled_v1', {
    message_id: hello.message_id,
    chat_id: TEAM,
    recall_time: String(Date.now()),
    recall_type: 'message_owner',
  })
  const recalled = messages.get(APP, hello.message_id)
  assert.equal(recalled?.state, 'recalled')
  assert.equal(recalled?.text, '[已撤回]')
  assert.equal(recalled?.content, null)

  if (process.platform !== 'win32') {
    const path = join(h.env.stateDir, IM_MESSAGES_FILE)
    assert.ok(existsSync(path))
    assert.equal(statSync(path).mode & 0o077, 0)
  }
})

test('接入补最近 7 天：窗口外的不补，超过 1000 条只留最新的；成员表落库，进退群事件更新', async (t) => {
  const { h, messages, records } = await setup(t)
  const now = Date.now()
  h.fake.postMessage({ chatId: TEAM, sender: 'ou_alice', text: '八天前', at: now - 8 * DAY })
  for (let index = 0; index < 1030; index += 1)
    h.fake.postMessage({
      chatId: TEAM,
      sender: index % 2 ? 'ou_alice' : 'ou_bob',
      text: `第 ${index} 条`,
      at: now - 3 * DAY + index * 1000,
    })
  const chat = await access(h, TEAM)
  assert.equal(chat.records?.backfill?.state, 'running')
  await records.idle()
  const after = (await h.admin.call(M.chatGet, { appId: APP, chatId: TEAM })).chat
  assert.equal(after.records?.messages, 1000)
  assert.deepEqual(
    {
      kind: after.records?.backfill?.kind,
      state: after.records?.backfill?.state,
      fetched: after.records?.backfill?.fetched,
      truncated: after.records?.backfill?.truncated,
    },
    { kind: 'access', state: 'done', fetched: 1000, truncated: true },
  )
  // 留的是最新的 1000 条：最早一条是第 30 条
  assert.equal(after.records?.oldestAt, Math.floor((now - 3 * DAY + 30 * 1000) / 1000))
  const sample = messages.get(APP, h.fake.messages.at(-1)?.message_id ?? '')
  assert.equal(sample?.source, 'backfill')
  assert.equal(sample?.triage, 'done')

  const roster = () =>
    messages
      .members(APP, TEAM)
      .map((member) => [member.openId, member.name, member.present])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  assert.deepEqual(roster(), [
    ['ou_alice', '示例成员甲', true],
    ['ou_bob', '示例成员乙', true],
  ])
  await h.fake.push(APP, 'im.chat.member.user.added_v1', {
    chat_id: TEAM,
    users: [{ name: '示例成员丙', tenant_key: 't', user_id: { open_id: 'ou_carol' } }],
  })
  await h.fake.push(APP, 'im.chat.member.user.deleted_v1', {
    chat_id: TEAM,
    users: [{ name: '示例成员乙', tenant_key: 't', user_id: { open_id: 'ou_bob' } }],
  })
  assert.deepEqual(roster(), [
    ['ou_alice', '示例成员甲', true],
    ['ou_bob', '示例成员乙', false],
    ['ou_carol', '示例成员丙', true],
  ])
})

test('断线重连补缺口；平台上编辑过、删掉的按最新版更新', async (t) => {
  const { h, messages, records } = await setup(t)
  const early = h.fake.postMessage({ chatId: TEAM, sender: 'ou_alice', text: '原话' })
  await access(h, TEAM)
  await records.idle()
  assert.equal(messages.get(APP, early.message_id)?.text, '原话')

  h.fake.drop(APP)
  const missed = h.fake.postMessage({ chatId: TEAM, sender: 'ou_bob', text: '断线时说的' })
  early.content = JSON.stringify({ text: '改过的话' })
  early.updated = true
  early.update_time = String(Date.now() + 1000)
  await h.until(() => h.fake.connected(APP) === 1, 10_000)
  const gap = await h.until(async () => {
    await records.idle()
    return (await h.admin.call(M.chatGet, { appId: APP, chatId: TEAM })).chat.records?.gap
  }, 10_000)
  assert.equal(gap.complete, true)
  assert.equal(gap.fetched, 1)
  assert.equal(messages.get(APP, missed.message_id)?.source, 'gap')
  // 补缺口和接入补的窗口重叠，同一条只存一次，内容换成编辑后的
  assert.equal(messages.get(APP, early.message_id)?.text, '改过的话')
  assert.equal(messages.count(APP, TEAM).messages, 2)
})

test('回源：合并转发逐条展开、卡片取原始结构、群名片换成群名', async (t) => {
  const { h, messages, records } = await setup(t)
  await access(h, TEAM)
  await records.idle()
  const forward = h.fake.postMessage({
    chatId: TEAM,
    sender: 'ou_alice',
    msgType: 'merge_forward',
    content: 'Merged and Forwarded Message',
  })
  const child = (id: string, msgType: string, content: string, cardRaw?: string) => ({
    ...h.fake.postMessage({ chatId: 'oc_elsewhere', sender: 'ou_bob', msgType, content }),
    message_id: id,
    ...(cardRaw ? { cardRaw } : {}),
  })
  forward.children = [
    child('om_child_text', 'text', '{"text":"转发的第一句"}'),
    child('om_child_file', 'file', '{"file_key":"file_k","file_name":"方案.docx"}'),
    child(
      'om_child_card',
      'interactive',
      '{"title":"","elements":[]}',
      JSON.stringify({ body: { elements: [{ tag: 'markdown', content: '子卡片正文' }] } }),
    ),
  ]
  await event(h, forward)
  const card = h.fake.postMessage({
    chatId: TEAM,
    sender: 'ou_alice',
    msgType: 'interactive',
    content: JSON.stringify({ title: '', elements: [] }),
  })
  card.cardRaw = JSON.stringify({
    header: { title: { tag: 'plain_text', content: '周报' } },
    body: { elements: [{ tag: 'markdown', content: '本周完成三项' }] },
  })
  await event(h, card)
  const share = h.fake.postMessage({
    chatId: TEAM,
    sender: 'ou_alice',
    msgType: 'share_chat',
    content: JSON.stringify({ chat_id: OTHER }),
  })
  await event(h, share)
  await records.idle()
  assert.equal(
    messages.get(APP, forward.message_id)?.text,
    '[合并转发]\n1. 转发的第一句\n2. [文件] 方案.docx\n3. 子卡片正文',
  )
  assert.deepEqual(
    messages
      .attachments(APP, forward.message_id)
      .map((item) => [item.fileKey, item.resourceMessageId]),
    [['file_k', forward.message_id]],
  )
  assert.equal(messages.get(APP, card.message_id)?.text, '周报\n本周完成三项')
  assert.equal(messages.get(APP, share.message_id)?.text, '[群名片] 示例闲聊群')
})

test('取消接入：默认删记录；不删的留着并标在群上，照保留期清理，被引用的只清正文', async (t) => {
  const { h, messages, records } = await setup(t)
  const now = Date.now()
  const old = h.fake.postMessage({
    chatId: TEAM,
    sender: 'ou_alice',
    text: '两天前',
    at: now - 2 * DAY,
  })
  const kept = h.fake.postMessage({
    chatId: TEAM,
    sender: 'ou_alice',
    text: '被引用的',
    at: now - 2 * DAY,
  })
  const fresh = h.fake.postMessage({ chatId: TEAM, sender: 'ou_bob', text: '刚才' })
  await access(h, TEAM)
  await records.idle()
  assert.equal(messages.count(APP, TEAM).messages, 3)
  assert.ok(messages.pin(APP, kept.message_id))

  let chat = (await h.admin.call(M.chatGet, { appId: APP, chatId: TEAM })).chat
  chat = (
    await h.admin.call(M.chatUpdate, {
      appId: APP,
      chatId: TEAM,
      expectedRevision: chat.revision,
      retentionDays: 1,
    })
  ).chat
  records.purgeAll()
  assert.equal(messages.get(APP, old.message_id), null)
  const pinned = messages.get(APP, kept.message_id)
  assert.equal(pinned?.text, null)
  assert.ok(pinned?.bodyPurgedAt)
  assert.equal(messages.get(APP, fresh.message_id)?.text, '刚才')

  // 不删记录：群上标着有记录，接入设置清空
  const left = (
    await h.admin.call(M.chatUnaccess, {
      appId: APP,
      chatId: TEAM,
      expectedRevision: chat.revision,
      deleteRecords: false,
    })
  ).chat
  assert.equal(left.access, null)
  assert.equal(left.records?.messages, 1)
  // 未接入后来的消息不再记
  await event(h, h.fake.postMessage({ chatId: TEAM, sender: 'ou_alice', text: '取消接入以后' }))
  assert.equal(messages.count(APP, TEAM).messages, 1)

  // 再接入、再取消并删除记录：只剩被引用消息的 ID
  const again = await access(h, OTHER)
  await records.idle()
  await event(h, h.fake.postMessage({ chatId: OTHER, sender: 'ou_alice', text: '闲聊' }))
  assert.equal(messages.count(APP, OTHER).messages, 1)
  const gone = (
    await h.admin.call(M.chatUnaccess, {
      appId: APP,
      chatId: OTHER,
      expectedRevision: again.revision,
      deleteRecords: true,
    })
  ).chat
  assert.equal(gone.records, undefined)
  assert.equal(messages.count(APP, OTHER).messages, 0)
  assert.deepEqual(messages.members(APP, OTHER), [])
})

test('手动补历史：只给已接入的群、窗口要合法、同时只跑一个；补进来的标 backfill', async (t) => {
  const { h, messages, records } = await setup(t)
  const now = Date.now()
  const month = h.fake.postMessage({
    chatId: TEAM,
    sender: 'ou_alice',
    text: '一个月前',
    at: now - 30 * DAY,
  })
  const notAccessed = await h.admin.fails(M.chatBackfill, {
    appId: APP,
    chatId: TEAM,
    start: Math.floor((now - 40 * DAY) / 1000),
    end: Math.floor(now / 1000),
  })
  assert.equal(notAccessed.message, 'feishu_chat_not_accessed')
  await access(h, TEAM)
  await records.idle()
  assert.equal(messages.get(APP, month.message_id), null)
  const inverted = await h.admin.fails(M.chatBackfill, {
    appId: APP,
    chatId: TEAM,
    start: Math.floor(now / 1000),
    end: Math.floor(now / 1000) - 10,
  })
  assert.equal(inverted.code, -32602)
  const window = {
    appId: APP,
    chatId: TEAM,
    start: Math.floor((now - 40 * DAY) / 1000),
    end: Math.floor((now - 20 * DAY) / 1000),
  }
  const { chat } = await h.admin.call(M.chatBackfill, window)
  assert.equal(chat.records?.backfill?.state, 'running')
  assert.equal(chat.records?.backfill?.kind, 'manual')
  const busy = await h.admin.fails(M.chatBackfill, window)
  assert.equal(busy.message, 'feishu_backfill_running')
  await records.idle()
  assert.equal(messages.get(APP, month.message_id)?.source, 'backfill')
  const done = (await h.admin.call(M.chatGet, { appId: APP, chatId: TEAM })).chat
  assert.deepEqual([done.records?.backfill?.state, done.records?.backfill?.fetched], ['done', 1])
})
