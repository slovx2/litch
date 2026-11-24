// F2：群列表与接入设置。真实 SDK 连回环上的假飞书：连上时同步群列表，进退群、改名、解散事件，
// 成员选择器，接入（必须选发言模式、外部群二次确认）、改设置、取消接入，审计与通知。
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import {
  type FeishuChat,
  type FeishuMember,
  type FeishuPerson,
  FEISHU_METHOD as M,
} from '../../protocol/src/feishu.mjs'
import { FeishuFakeHarness } from './feishu-harness.mjs'

const APP = 'cli_0123456789abcdef'
const TEAM = 'oc_team'
const OUTSIDE = 'oc_partner'
const IDLE = 'oc_idle'

async function setup(t: TestContext) {
  const h = await FeishuFakeHarness.start(t)
  h.fake.addApp({ appId: APP })
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
    chatId: OUTSIDE,
    name: '示例合作群',
    external: true,
    bots: new Set([APP]),
    members: [{ openId: 'ou_carol', name: '示例成员丙' }],
  })
  h.fake.addChat({ chatId: IDLE, name: '没拉机器人的群', members: [] })
  await h.configure(APP)
  return h
}

const chatOf = async (h: FeishuFakeHarness, chatId: string) =>
  (await h.admin.call(M.chatGet, { appId: APP, chatId })).chat

test('连上就同步群列表：只列机器人所在的群，全部未接入；没声明扩展、非管理员的写入被拒', async (t) => {
  const h = await setup(t)
  const { chats } = await h.until(async () => {
    const value = await h.admin.call(M.chatList, { appId: APP })
    return value.chats.length === 2 ? value : undefined
  })
  assert.deepEqual(chats.map((chat: FeishuChat) => chat.chatId).sort(), [OUTSIDE, TEAM])
  assert.ok(chats.every((chat: FeishuChat) => chat.access === null && chat.botPresent))
  assert.equal(chats.find((chat: FeishuChat) => chat.chatId === OUTSIDE)?.external, true)
  const listed = await h.admin.call(M.appList, {})
  assert.equal(listed.admin, true)
  const plain = h.env.connect()
  await plain.initialize(['harness', 'litchFeishu'])
  assert.equal((await plain.call(M.appList, {})).admin, false)
  const team = chats.find((chat: FeishuChat) => chat.chatId === TEAM)
  const denied = await plain.fails(M.chatAccess, {
    appId: APP,
    chatId: TEAM,
    expectedRevision: team?.revision ?? 1,
    speech: 'free',
    wakeBound: true,
    wakers: [],
    retentionDays: 90,
    reviewTtlHours: 24,
  })
  assert.equal((denied.data as { litch?: string }).litch, 'deviceAdminRequired')
  plain.close()
})

test('接入：选成员、发言模式进通用发言权限；外部群不确认不让接；改设置、取消接入；全程记审计', async (t) => {
  const h = await setup(t)
  await h.until(async () => (await h.admin.call(M.chatList, { appId: APP })).chats.length === 2)
  const { members } = await h.admin.call(M.chatMembers, { appId: APP, chatId: TEAM })
  assert.deepEqual(
    members.map((member: FeishuMember) => member.name),
    ['示例成员甲', '示例成员乙'],
  )
  const team = await chatOf(h, TEAM)
  const base = {
    appId: APP,
    wakeBound: true,
    wakers: ['ou_alice'],
    retentionDays: 30,
    reviewTtlHours: 12,
  }
  const notMember = await h.admin.fails(M.chatAccess, {
    ...base,
    chatId: TEAM,
    expectedRevision: team.revision,
    speech: 'free',
    wakers: ['ou_carol'],
  })
  assert.equal(notMember.message, 'feishu_waker_not_member')
  const { chat } = await h.admin.call(M.chatAccess, {
    ...base,
    chatId: TEAM,
    expectedRevision: team.revision,
    speech: 'free',
  })
  assert.equal(chat.revision, team.revision + 1)
  assert.deepEqual(chat.access?.wakers, [{ openId: 'ou_alice', name: '示例成员甲' }])
  assert.equal(chat.access?.speech, 'free')
  assert.equal(chat.access?.reviewTtlHours, 12)
  assert.equal(h.env.device.feishu?.policies.decide('feishu', `${APP}/${TEAM}`), 'free')
  assert.equal(h.env.device.feishu?.policies.decide('feishu', `${APP}/${OUTSIDE}`), 'denied')
  await h.admin.waitFor(
    (frame) =>
      frame.method === 'litch/feishu/chatsChanged' &&
      (frame.params as { chatId?: string }).chatId === TEAM,
  )
  const again = await h.admin.fails(M.chatAccess, {
    ...base,
    chatId: TEAM,
    expectedRevision: chat.revision,
    speech: 'free',
  })
  assert.equal(again.message, 'feishu_chat_accessed')

  const outside = await chatOf(h, OUTSIDE)
  const unconfirmed = await h.admin.fails(M.chatAccess, {
    ...base,
    wakers: [],
    chatId: OUTSIDE,
    expectedRevision: outside.revision,
    speech: 'approval',
  })
  assert.equal(unconfirmed.message, 'feishu_external_unconfirmed')
  const confirmed = await h.admin.call(M.chatAccess, {
    ...base,
    wakers: [],
    chatId: OUTSIDE,
    expectedRevision: outside.revision,
    speech: 'approval',
    confirmExternal: true,
  })
  assert.equal(confirmed.chat.access?.speech, 'approval')

  const stale = await h.admin.fails(M.chatUpdate, {
    appId: APP,
    chatId: TEAM,
    expectedRevision: team.revision,
    speech: 'approval',
  })
  assert.equal(stale.message, 'feishu_revision_conflict')
  const updated = await h.admin.call(M.chatUpdate, {
    appId: APP,
    chatId: TEAM,
    expectedRevision: chat.revision,
    speech: 'approval',
    wakers: ['ou_alice', 'ou_bob'],
    reviewTtlHours: 48,
  })
  assert.equal(updated.chat.access?.speech, 'approval')
  assert.equal(updated.chat.access?.reviewTtlHours, 48)
  assert.equal(updated.chat.access?.retentionDays, 30)
  assert.deepEqual(
    updated.chat.access?.wakers.map((person: FeishuPerson) => person.name),
    ['示例成员甲', '示例成员乙'],
  )
  const removed = await h.admin.call(M.chatUnaccess, {
    appId: APP,
    chatId: TEAM,
    expectedRevision: updated.chat.revision,
    deleteRecords: true,
  })
  assert.equal(removed.chat.access, null)
  assert.equal(h.env.device.feishu?.policies.decide('feishu', `${APP}/${TEAM}`), 'denied')
  const actions = h.env.device.feishu?.store.auditEntries(APP).map((entry) => entry.action)
  assert.deepEqual(
    actions?.filter((action) => action.startsWith('chat_')),
    ['chat_accessed', 'chat_accessed', 'chat_updated', 'chat_unaccessed'],
  )
})

test('进退群事件：被拉进群只进列表；移出已接入的群保留设置，重新拉进来自动恢复；改名、解散', async (t) => {
  const h = await setup(t)
  await h.until(async () => (await h.admin.call(M.chatList, { appId: APP })).chats.length === 2)
  // 机器人被拉进新群：只出现在列表里，未接入
  h.fake.chats.get(IDLE)?.bots.add(APP)
  await h.fake.push(APP, 'im.chat.member.bot.added_v1', {
    chat_id: IDLE,
    name: '没拉机器人的群',
    external: false,
  })
  const idle = await chatOf(h, IDLE)
  assert.equal(idle.access, null)
  assert.equal(idle.botPresent, true)

  const team = await chatOf(h, TEAM)
  const { chat } = await h.admin.call(M.chatAccess, {
    appId: APP,
    chatId: TEAM,
    expectedRevision: team.revision,
    speech: 'approval',
    wakeBound: false,
    wakers: [],
    retentionDays: 90,
    reviewTtlHours: 24,
  })
  h.fake.chats.get(TEAM)?.bots.delete(APP)
  await h.fake.push(APP, 'im.chat.member.bot.deleted_v1', { chat_id: TEAM, name: '示例项目群' })
  const gone = await chatOf(h, TEAM)
  assert.equal(gone.botPresent, false)
  assert.equal(gone.access?.speech, 'approval')
  assert.equal(h.env.device.feishu?.chats.active(APP, TEAM), false)
  // 没接入的群被移出就忘掉
  await h.fake.push(APP, 'im.chat.member.bot.deleted_v1', { chat_id: IDLE })
  assert.equal(
    (await h.admin.fails(M.chatGet, { appId: APP, chatId: IDLE })).message,
    'feishu_chat_not_found',
  )
  h.fake.chats.get(TEAM)?.bots.add(APP)
  await h.fake.push(APP, 'im.chat.member.bot.added_v1', { chat_id: TEAM, name: '示例项目群' })
  const back = await chatOf(h, TEAM)
  assert.equal(back.botPresent, true)
  assert.equal(back.access?.speech, 'approval')
  assert.equal(back.revision, chat.revision, '系统同步不升版本')
  assert.equal(h.env.device.feishu?.chats.active(APP, TEAM), true)

  await h.fake.push(APP, 'im.chat.updated_v1', {
    chat_id: TEAM,
    after_change: { name: '示例项目群（改名）' },
  })
  assert.equal((await chatOf(h, TEAM)).name, '示例项目群（改名）')
  await h.fake.push(APP, 'im.chat.disbanded_v1', { chat_id: TEAM })
  const dissolved = await chatOf(h, TEAM)
  assert.equal(dissolved.status, 'dissolved')
  assert.equal(h.env.device.feishu?.chats.active(APP, TEAM), false)
  const members = await h.admin.fails(M.chatMembers, { appId: APP, chatId: TEAM })
  assert.equal(members.message, 'feishu_chat_unavailable')
  // 解散的群取消接入后不再留着
  await h.admin.call(M.chatUnaccess, {
    appId: APP,
    chatId: TEAM,
    expectedRevision: dissolved.revision,
    deleteRecords: false,
  })
  assert.equal(
    (await h.admin.fails(M.chatGet, { appId: APP, chatId: TEAM })).message,
    'feishu_chat_not_found',
  )
})

test('断线期间被移出群：重连后对账标“机器人已不在群里”；移除应用清掉群和发言模式', async (t) => {
  const h = await setup(t)
  await h.until(async () => (await h.admin.call(M.chatList, { appId: APP })).chats.length === 2)
  const team = await chatOf(h, TEAM)
  await h.admin.call(M.chatAccess, {
    appId: APP,
    chatId: TEAM,
    expectedRevision: team.revision,
    speech: 'free',
    wakeBound: true,
    wakers: [],
    retentionDays: 90,
    reviewTtlHours: 24,
  })
  h.fake.chats.get(TEAM)?.bots.delete(APP)
  h.fake.chats.get(OUTSIDE)?.bots.delete(APP)
  const before = h.fake.connected(APP)
  h.fake.drop(APP)
  await h.until(() => h.fake.connected(APP) >= before, 15000)
  const synced = await h.until(async () => {
    const { chats } = await h.admin.call(M.chatList, { appId: APP })
    return chats.length === 1 && chats[0]?.botPresent === false ? chats : undefined
  }, 15000)
  assert.equal(synced[0]?.chatId, TEAM)
  const refreshed = await h.admin.call(M.chatList, { appId: APP, refresh: true })
  assert.ok(refreshed.syncedAt)
  const { apps } = await h.admin.call(M.appList, {})
  await h.admin.call(M.appRemove, { appId: APP, expectedRevision: apps[0]?.revision ?? 1 })
  assert.equal(h.env.device.feishu?.policies.decide('feishu', `${APP}/${TEAM}`), 'denied')
  const count = h.env.device.feishu?.store.managers.db
    .prepare('SELECT count(*) AS n FROM feishu_chats')
    .get() as { n: number }
  assert.equal(count.n, 0)
})
