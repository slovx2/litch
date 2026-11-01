import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type CoreChannel,
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  createSidebarActivity,
  keys,
  pageSidebarProjection,
  projectSidebarGroups,
  type SessionInteraction,
  type SessionSummary,
  type SidebarProjections,
  serveChannel,
} from '../src/index.mjs'
import { sampleSidebars } from '../src/mock/sample-data.mjs'
import { fakeClock, settle } from './helpers.mjs'

const example = sampleSidebars(10_000, 'zh-CN')[0]?.sessions[0]
assert.ok(example)
const summary = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({
  ...example,
  id,
  unread: false,
  pinned: false,
  updatedAt: 10,
  ...patch,
})
const map = (...rows: SessionSummary[]) => new Map(rows.map((row) => [row.id, row]))
const child = (id: string, parent: string, patch: Partial<SessionSummary> = {}) =>
  summary(id, {
    nativeLineage: { app: 'claude-desktop', parentId: parent, createdAt: 1 },
    ...patch,
  })

test('未读按后代归并主项；最近只认主动交互，排序不受 updatedAt 和置顶影响', () => {
  const sessions = map(
    summary('a', { updatedAt: 999_999, pinned: true }),
    summary('a1', {
      unread: true,
      updatedAt: 50,
      lineage: {
        parentId: 'a',
        kind: 'fresh',
        origin: 'model',
        title: '子会话',
        wakeParent: true,
        reportParent: true,
        createdAt: 1,
        proposalId: null,
      },
    }),
    child('a2', 'a1', { unread: true, updatedAt: 70 }),
    summary('b', { unread: true, updatedAt: 60 }),
    summary('c', { updatedAt: 999_999 }),
  )
  const result = projectSidebarGroups(
    'local',
    sessions,
    (id) => ({ a1: 200, a2: 100, b: 300 })[id] ?? 0,
  )
  assert.deepEqual(
    result.unread.map((row) => [row.sessionId, row.at]),
    [
      ['a', 70],
      ['b', 60],
    ],
  )
  assert.deepEqual(
    result.recent.map((row) => [row.sessionId, row.at]),
    [
      ['b', 300],
      ['a', 200],
    ],
  )
  assert.equal(result.unread[0]?.workspaceId, sessions.get('a')?.workspaceId)
  // 脱离父会话后才作为新的主项；读取历史、自动回合不参与判定。
  const detached = sessions.get('a1')
  assert.ok(detached)
  sessions.set('a1', { ...detached, lineage: null })
  assert.deepEqual(
    projectSidebarGroups('local', sessions, () => 0).unread.map((row) => row.sessionId),
    ['a1', 'b'],
  )
})

test('排除经理及后代、缺失父项、环和未知原生父项；归档不进入活动目录', () => {
  const manager = { ...summary('manager'), litchManager: { role: 'manager', managerId: 'm' } }
  const sessions = map(
    manager,
    child('line', 'manager', { unread: true }),
    child('orphan', 'archived', { unread: true }),
    child('cycle1', 'cycle2'),
    child('cycle2', 'cycle1'),
    summary('native', { nativeLineage: { app: 'x', parentId: null, createdAt: 1 } }),
    summary('normal', { unread: true }),
  )
  const result = projectSidebarGroups('remote', sessions, () => 10)
  assert.deepEqual(
    result.unread.map((row) => row.sessionId),
    ['normal'],
  )
  assert.deepEqual(
    result.recent.map((row) => row.sessionId),
    ['normal'],
  )
})

test('跨设备全局排序，先分页后按项目聚合，同名或同 ID 项目不跨设备混合', () => {
  const rows = [
    { deviceId: 'a', sessionId: 'a1', workspaceId: 'project', at: 100 },
    { deviceId: 'b', sessionId: 'b1', workspaceId: 'project', at: 90 },
    { deviceId: 'a', sessionId: 'a2', workspaceId: 'project', at: 80 },
    { deviceId: 'a', sessionId: 'a3', workspaceId: null, at: 70 },
    { deviceId: 'b', sessionId: 'b2', workspaceId: null, at: 60 },
  ].reverse()
  const flat = pageSidebarProjection(rows, false, 3)
  assert.deepEqual(
    flat.blocks.map((b) => b.rows[0]?.sessionId),
    ['a1', 'b1', 'a2'],
  )
  assert.equal(flat.remaining, 2)
  const grouped = pageSidebarProjection(rows, true, 3)
  assert.deepEqual(
    grouped.blocks.map((b) => b.rows.map((r) => r.sessionId)),
    [['a1', 'a2'], ['b1']],
  )
  assert.equal(grouped.remaining, 2)
  assert.equal(pageSidebarProjection(rows, true, 13).blocks.length, 4)
  assert.equal(pageSidebarProjection(rows, true, 13).remaining, 0)
  assert.equal(pageSidebarProjection(rows, false, 0).remaining, 5)
})

test('一万层父链归并不递归、不读取正文；最近没有数量上限', () => {
  const rows = Array.from({ length: 10_000 }, (_, index) =>
    index === 0 ? summary('0') : child(String(index), String(index - 1)),
  )
  const started = performance.now()
  const result = projectSidebarGroups('d', map(...rows.reverse()), () => 1)
  assert.equal(result.recent.length, 1)
  assert.equal(result.recent[0]?.sessionId, '0')
  const roots = projectSidebarGroups(
    'd',
    map(...rows.map((row) => ({ ...row, nativeLineage: null }))),
    () => 1,
  )
  assert.equal(pageSidebarProjection(roots.recent, false, 20_000).blocks.length, 10_000)
  assert.ok(performance.now() - started < 3000)
})

test('查看去重、同毫秒跨会话排序、持久化合并与重启恢复', () => {
  const time = fakeClock()
  const writes: SessionInteraction[][] = []
  const channel = {
    command: async () => ({}),
    subscribe: () => () => {},
    close() {},
  } as CoreChannel
  const activity = createSidebarActivity(channel, time.clock, {
    load: () => [],
    save: (rows) => writes.push([...rows]),
  })
  let changes = 0
  activity.subscribe(() => changes++)
  activity.visit('d', 'a')
  const first = activity.time('d', 'a')
  activity.visit('d', 'a')
  assert.equal(changes, 1)
  activity.visit('d', 'b')
  activity.visit('d', 'a')
  assert.ok(activity.time('d', 'a') > activity.time('d', 'b'))
  assert.ok(activity.time('d', 'a') > first)
  assert.equal(time.pending(), 1)
  assert.equal(writes.length, 0)
  time.advance(1000)
  assert.equal(writes.length, 1)
  const restored = createSidebarActivity(channel, time.clock, { load: () => writes[0], save() {} })
  assert.equal(restored.time('d', 'a'), activity.time('d', 'a'))
  activity.visit('d', 'a')
  activity.flush()
  assert.equal(writes.length, 2)
  assert.equal(time.pending(), 0)
})

test('仅成功用户命令计入；读取、已读、订阅不计；慢应答不覆盖后来的操作', async () => {
  const time = fakeClock()
  let finish: (() => void) | undefined
  const channel = {
    command: async (name: string) => {
      if (name === 'session.interrupt') throw new Error('未受理')
      if (name === 'session.send')
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      return name === 'session.create' ? { sessionId: 'new' } : {}
    },
    subscribe: () => () => {},
    close() {},
  } as CoreChannel
  const activity = createSidebarActivity(channel, time.clock)
  const where = { deviceId: 'd', sessionId: 'a' }
  await activity.channel.command('session.markRead', where)
  await activity.channel.command('session.peek', where)
  activity.channel.subscribe({ kind: 'session', ...where }, { snapshot() {}, delta() {} })()
  assert.equal(activity.time('d', 'a'), 0)
  await assert.rejects(activity.channel.command('session.interrupt', where))
  assert.equal(activity.time('d', 'a'), 0)
  const sending = activity.channel.command('session.send', { ...where, text: 'hello' })
  time.advance(50)
  activity.visit('d', 'a')
  const after = activity.time('d', 'a')
  finish?.()
  await sending
  assert.equal(activity.time('d', 'a'), after)
  time.advance(10)
  await activity.channel.command('session.respond', {
    ...where,
    requestId: 'r',
    optionId: 'reject',
  })
  assert.ok(activity.time('d', 'a') > after)
  await activity.channel.command('session.resumeQueue', where)
  await activity.channel.command('session.create', { deviceId: 'd', cwd: null, text: 'new' })
  assert.ok(activity.time('d', 'new') > 0)
})

test('副本订阅投影：查看马上入最近、已读移出未读、归档移除、后台进展不更新时间', async () => {
  const time = fakeClock()
  const [ui, server] = createPortPair()
  const host = createMockCore({ clock: time.clock, chunkMs: 0 })
  serveChannel(server, host, { clock: time.clock })
  const activity = createSidebarActivity(connectChannel(ui), time.clock)
  const replica = createReplica(activity.channel, activity)
  const stop = replica.start()
  await settle()
  await settle()
  const view = () => {
    const value = replica.store.get<SidebarProjections>(keys.sidebarProjections('local'))
    assert.ok(value)
    return value
  }
  assert.equal(view().recent.length, 0)
  assert.ok(view().unread.some((row) => row.sessionId === 's3'))
  replica.visitSession('local', 's3')
  assert.equal(view().recent[0]?.sessionId, 's3')
  await activity.channel.command('session.markRead', { deviceId: 'local', sessionId: 's3' })
  time.advance(20)
  await settle()
  assert.ok(!view().unread.some((row) => row.sessionId === 's3'))
  const at = view().recent[0]?.at
  // 绕过 UI 通道的后台消息不会写主动交互表。
  await host.command(
    'session.send',
    { deviceId: 'local', sessionId: 's3', text: '后台' },
    { aborted: false, addEventListener() {} },
  )
  time.advance(20)
  await settle()
  assert.equal(view().recent[0]?.at, at)
  await activity.channel.command('session.archive', { deviceId: 'local', sessionId: 's3' })
  time.advance(20)
  await settle()
  assert.ok(!view().recent.some((row) => row.sessionId === 's3'))
  stop()
  activity.channel.close()
})
