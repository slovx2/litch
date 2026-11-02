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
  retainOpenedUnread,
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

test('当前打开的未读主项保留原位置，切走移除；不篡改未读目录或时间', () => {
  const a = { deviceId: 'local', sessionId: 'a', workspaceId: 'w', at: 100 }
  const b = { ...a, sessionId: 'b', at: 90 }
  const remote = { ...a, deviceId: 'remote', at: 200 }
  const rows = [b, remote]
  const opened = { row: a, index: 0 }
  assert.deepEqual(retainOpenedUnread(rows, opened), [a, remote, b])
  assert.deepEqual(rows, [b, remote], '已读项只暂留在显示投影，不写回未读目录')
  assert.deepEqual(retainOpenedUnread(rows, null), [remote, b], '切走后立即移出')
  assert.deepEqual(retainOpenedUnread([a, b], opened), [a, b], '还未清除标记时不重复')
  const updated = { ...a, at: 300 }
  assert.deepEqual(retainOpenedUnread([updated, b, remote], { row: a, index: 1 }), [
    remote,
    updated,
    b,
  ])
  assert.deepEqual(
    pageSidebarProjection(rows, false, 2, opened).blocks.map((block) => block.rows[0]),
    [a, remote],
  )
  assert.equal(pageSidebarProjection(rows, false, 2, opened).remaining, 1)
  assert.deepEqual(pageSidebarProjection([b], true, 5, opened).blocks[0]?.rows, [a, b])
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

test('经理成为主项、工作线归入经理；缺失父项、环和未知原生父项不进入投影', () => {
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
    ['manager', 'normal'],
  )
  assert.deepEqual(
    result.recent.map((row) => row.sessionId),
    ['manager', 'normal'],
  )
})

test('经理自己的未读和操作可入组，深层工作线不单列，孤立工作线不伪装成主项', () => {
  const manager = {
    ...child('manager', 'missing'),
    litchManager: { role: 'manager', managerId: 'm' },
    unread: true,
    updatedAt: 20,
  }
  const line = { ...child('line', 'manager'), litchManager: { role: 'line', managerId: 'm' } }
  const orphan = {
    ...summary('orphan'),
    litchManager: { role: 'line', managerId: 'gone' },
    unread: true,
  }
  const sessions = map(
    child('nested', 'line', { unread: true, updatedAt: 80 }),
    line,
    manager,
    orphan,
  )
  const projected = projectSidebarGroups('d', sessions, (id) => (id === 'nested' ? 100 : 0))
  assert.deepEqual(projected.unread, [
    { deviceId: 'd', sessionId: 'manager', workspaceId: manager.workspaceId, at: 80 },
  ])
  assert.deepEqual(projected.recent, [{ ...projected.unread[0], at: 100 }])
  assert.equal(projectSidebarGroups('d', map(manager), () => 30).recent[0]?.sessionId, 'manager')
  sessions.delete('manager')
  assert.deepEqual(
    projectSidebarGroups('d', sessions, () => 100),
    { recent: [], unread: [] },
  )
})

test('经理主动操作按经理会话记最近；阅读、拒绝受理、空答复与失败不记', async () => {
  const time = fakeClock()
  let response: unknown = {}
  const channel = {
    command: async () => {
      if (response instanceof Error) throw response
      return response
    },
    subscribe: () => () => {},
    close() {},
  } as CoreChannel
  const activity = createSidebarActivity(channel, time.clock)
  activity.setManagers('d', [{ id: 'manager', threadId: 'thread' }])
  await activity.channel.command('managers.question.ask', {
    deviceId: 'd',
    managerId: 'manager',
    decisionId: 'D-1',
    revision: 1,
    question: '追问',
  })
  const at = activity.time('d', 'thread')
  assert.ok(at > 0)
  response = { queued: false }
  await activity.channel.command('managers.question.forward', {
    deviceId: 'd',
    managerId: 'manager',
    decisionId: 'D-1',
  })
  response = { accepted: [], rejected: [], delivery: 'none' }
  await activity.channel.command('managers.answers.submit', {
    deviceId: 'd',
    managerId: 'manager',
    answers: [],
  })
  await activity.channel.command('managers.reference.read', {
    deviceId: 'd',
    managerId: 'manager',
    reference: 'note',
  })
  response = new Error('offline')
  await assert.rejects(
    activity.channel.command('managers.end', { deviceId: 'd', managerId: 'manager' }),
  )
  assert.equal(activity.time('d', 'thread'), at)
  response = { queued: true }
  await activity.channel.command('managers.question.forward', {
    deviceId: 'd',
    managerId: 'manager',
    decisionId: 'D-1',
  })
  assert.ok(activity.time('d', 'thread') > at)
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

test('连续前台查看满五秒记一次，时间取达标时刻，持久化和重启恢复', () => {
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
  activity.setForeground(true)
  activity.view({ deviceId: 'd', sessionId: 'a' })
  time.advance(4999)
  assert.equal(activity.time('d', 'a'), 0)
  activity.view({ deviceId: 'd', sessionId: 'a' })
  time.advance(1)
  const first = activity.time('d', 'a')
  assert.equal(first, time.clock.now())
  assert.equal(changes, 1)
  assert.equal(time.pending(), 1)
  assert.equal(writes.length, 0)
  time.advance(1000)
  assert.equal(writes.length, 1)
  time.advance(60_000)
  assert.equal(activity.time('d', 'a'), first, '一直停留不重复更新')
  assert.equal(changes, 1)
  assert.equal(time.pending(), 0)
  const restored = createSidebarActivity(channel, time.clock, { load: () => writes[0], save() {} })
  assert.equal(restored.time('d', 'a'), activity.time('d', 'a'))
  activity.view(null)
  activity.view({ deviceId: 'd', sessionId: 'a' })
  time.advance(5000)
  activity.flush()
  assert.equal(writes.length, 2)
  assert.equal(time.pending(), 0)
})

test('短暂查看、切走、失去前台都清零；默认后台不计时，关闭后不遗留计时', () => {
  const time = fakeClock()
  const channel = {
    command: async () => ({}),
    subscribe: () => () => {},
    close() {},
  } as CoreChannel
  const activity = createSidebarActivity(channel, time.clock)
  const a = { deviceId: 'd', sessionId: 'a' }
  activity.view(a)
  time.advance(10_000)
  assert.equal(activity.time('d', 'a'), 0)
  activity.setForeground(true)
  time.advance(4999)
  activity.view({ deviceId: 'd', sessionId: 'b' })
  time.advance(1000)
  activity.view(a)
  time.advance(4999)
  assert.equal(activity.time('d', 'a'), 0)
  assert.equal(activity.time('d', 'b'), 0)
  activity.setForeground(false)
  time.advance(10_000)
  assert.equal(activity.time('d', 'a'), 0)
  activity.setForeground(true)
  time.advance(4999)
  assert.equal(activity.time('d', 'a'), 0)
  time.advance(1)
  assert.equal(activity.time('d', 'a'), time.clock.now())
  activity.view({ deviceId: 'other-device', sessionId: 'a' })
  time.advance(4999)
  activity.view(null)
  time.advance(1)
  assert.equal(activity.time('other-device', 'a'), 0)
  activity.view(a)
  activity.channel.close()
  assert.equal(time.pending(), 0)
})

test('主动发送、回答和停止立即计入，不用等待查看达标', async () => {
  const time = fakeClock()
  const channel = {
    command: async () => ({}),
    subscribe: () => () => {},
    close() {},
  } as CoreChannel
  const activity = createSidebarActivity(channel, time.clock)
  const where = { deviceId: 'd', sessionId: 'a' }
  activity.setForeground(true)
  activity.view(where)
  time.advance(1000)
  await activity.channel.command('session.send', { ...where, text: '主动消息' })
  assert.equal(activity.time('d', 'a'), time.clock.now())
  time.advance(1000)
  await activity.channel.command('session.respond', {
    ...where,
    requestId: 'r',
    optionId: 'reject',
  })
  assert.equal(activity.time('d', 'a'), time.clock.now())
  time.advance(1000)
  await activity.channel.command('session.interrupt', where)
  const at = activity.time('d', 'a')
  assert.equal(at, time.clock.now())
  activity.view(null)
  time.advance(10_000)
  assert.equal(activity.time('d', 'a'), at)
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
  activity.setForeground(true)
  const where = { deviceId: 'd', sessionId: 'a' }
  await activity.channel.command('session.markRead', where)
  await activity.channel.command('session.peek', where)
  activity.channel.subscribe({ kind: 'session', ...where }, { snapshot() {}, delta() {} })()
  assert.equal(activity.time('d', 'a'), 0)
  await assert.rejects(activity.channel.command('session.interrupt', where))
  assert.equal(activity.time('d', 'a'), 0)
  const sending = activity.channel.command('session.send', { ...where, text: 'hello' })
  time.advance(50)
  activity.view(where)
  time.advance(5000)
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

test('副本订阅投影：打开即清未读但五秒后才进最近，归档移除，后台进展不刷新', async () => {
  const time = fakeClock()
  const [ui, server] = createPortPair()
  const host = createMockCore({ clock: time.clock, chunkMs: 0 })
  serveChannel(server, host, { clock: time.clock })
  const activity = createSidebarActivity(connectChannel(ui), time.clock)
  activity.setForeground(true)
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
  replica.viewSession({ deviceId: 'local', sessionId: 's3' })
  assert.equal(view().recent.length, 0)
  await activity.channel.command('session.markRead', { deviceId: 'local', sessionId: 's3' })
  time.advance(20)
  await settle()
  assert.ok(!view().unread.some((row) => row.sessionId === 's3'))
  assert.equal(view().recent.length, 0)
  time.advance(4980)
  assert.equal(view().recent[0]?.sessionId, 's3')
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
