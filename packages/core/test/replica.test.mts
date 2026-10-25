import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type AgentMessageItem,
  type ChannelErrorShape,
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  type DeviceActivity,
  type DeviceView,
  type GroupTallies,
  groupOfSection,
  keys,
  LOOSE,
  type ManageRevisions,
  type ManageSchema,
  PINNED,
  type SessionChildren,
  type SessionGroups,
  type SessionHarnesses,
  type SessionMeta,
  type SessionSummary,
  type SettingsSnapshotView,
  serveChannel,
  type TurnView,
} from '../src/index.mjs'
import { STREAM_SESSION, streamText } from '../src/mock/sample-data.mjs'
import { sameTallies } from '../src/replica/replica.mjs'
import { fakeClock, settle } from './helpers.mjs'

const { head: STREAM_HEAD, rest: STREAM_REST } = streamText('zh-CN')

async function setup() {
  const time = fakeClock()
  const [uiPort, corePort] = createPortPair()
  serveChannel(corePort, createMockCore({ clock: time.clock, chunkMs: 60 }), { clock: time.clock })
  const channel = connectChannel(uiPort)
  const replica = createReplica(channel)
  const stop = replica.start()
  // 应用快照到了之后才会去订阅各设备的侧栏，所以要等两轮
  await settle()
  await settle()
  const count = (key: string) => {
    const counter = { n: 0 }
    replica.store.subscribe(key, () => counter.n++)
    return counter
  }
  return { time, channel, replica, store: replica.store, stop, count }
}

test('启动后：设备、工作区、分组都在，分组按最近更新排序', async () => {
  const { store } = await setup()
  assert.deepEqual(store.get(keys.devices), ['local', 'build', 'nas', 'gpu'])
  assert.equal(store.get<DeviceView>(keys.device('gpu'))?.connection, 'reconnecting')
  const groups = store.get<SessionGroups>(keys.groups('local'))
  assert.deepEqual(groups, {
    // cd1 是 Claude 桌面端派出来的：分组里照样有，侧栏默认藏着（keys.nativeChildren）
    litch: ['s1', 's2', 's3', 's4', 'cd1', 's5'],
    docs: ['s7', 's6', 's8', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9'],
    [LOOSE]: ['s9'],
    // 置顶的、在自定义分区里的各自单列，不再出现在工作区里。组里按放进去的先后排
    [PINNED]: ['p1', 'p2'],
    [groupOfSection('sec-later')]: ['k1'],
  })
  assert.deepEqual(store.get(keys.sections('local')), [{ id: 'sec-later', name: '稍后看' }])
  assert.deepEqual(store.get(keys.sections('build')), [])
  assert.equal(store.get<SessionSummary>(keys.summary('build', 'b1'))?.waitingFor, 'answer')
  // 停下来等人的会话单独列着：侧栏把会话折起来一部分时，这些不能折掉
  assert.deepEqual(store.get(keys.pressing('local')), ['s2'])
  assert.deepEqual(store.get(keys.pressing('build')), ['b1'])
  assert.deepEqual(store.get(keys.pressing('nas')), [])
  // 活动的会话（在跑、等人、没看过、只剩后台任务在跑）也单独列着：“永远显示活动对话”时筛选筛不掉
  assert.deepEqual(store.get(keys.active('local')), ['s1', 's2', 's3', 's7'])
  assert.deepEqual(store.get(keys.active('build')), ['b1'])
  assert.deepEqual(store.get(keys.active('nas')), [])
  // 别的应用派出来的会话单独列着：侧栏按“更多”里的开关决定藏不藏
  assert.deepEqual(store.get(keys.nativeChildren('local')), ['cd1'])
  assert.deepEqual(store.get(keys.nativeChildren('build')), [])
  // 认得出父会话的挂在父会话下面（和 Litch 自己的子会话在同一张表里）
  assert.deepEqual(store.get<SessionChildren>(keys.children('local'))?.s1, ['cd1'])
})

test('每台设备的忙闲汇总：几个在跑、几个在等人、最近一次动静；会话的状态变了它跟着变', async () => {
  const { store, channel, time, count } = await setup()
  const activity = (deviceId: string) => store.get<DeviceActivity>(keys.activity(deviceId))
  const latest = (deviceId: string) =>
    Math.max(
      ...Object.values(store.get<SessionGroups>(keys.groups(deviceId)) ?? {})
        .flat()
        .map((id) => store.get<SessionSummary>(keys.summary(deviceId, id))?.updatedAt ?? 0),
    )
  const local = activity('local')
  assert.deepEqual([local?.running, local?.waiting], [1, 1])
  assert.equal(local?.lastActiveAt, latest('local'))
  assert.deepEqual([activity('build')?.running, activity('build')?.waiting], [0, 1])
  assert.deepEqual([activity('nas')?.running, activity('nas')?.waiting], [0, 0])
  // 刚加进来、一个会话都没有的设备：都闲着，也说不出最近一次是什么时候
  const { deviceId: added } = await channel.command('device.add', {
    name: '',
    target: { kind: 'alias', alias: 'build-02' },
  })
  // 新设备先经应用的增量到这边，这边才去订阅它的侧栏：要等两轮
  time.advance(16)
  await settle()
  time.advance(16)
  await settle()
  assert.deepEqual(activity(added), { running: 0, waiting: 0, lastActiveAt: null })

  // 标成已读不动这几个数：订阅它的那一行不重画
  const seen = count(keys.activity('local'))
  await channel.command('session.markRead', { deviceId: 'local', sessionId: 's3' })
  time.advance(16)
  await settle()
  assert.equal(seen.n, 0)

  // 在一个闲着的会话里发一句：多一个在跑的，最近一次动静也往后挪
  const before = activity('local')?.lastActiveAt ?? 0
  time.advance(5000)
  await channel.command('session.send', { deviceId: 'local', sessionId: 's3', text: '在吗' })
  time.advance(16)
  await settle()
  assert.equal(activity('local')?.running, 2)
  assert.ok((activity('local')?.lastActiveAt ?? 0) > before)
  assert.ok(seen.n >= 1)
})

test('要人看一眼的会话数（等人的、没看过的，一个只算一次）；会话摘要换了通知听的人，带着换之前那一份', async () => {
  const { store, channel, replica, time } = await setup()
  const expected = (deviceId: string) =>
    Object.values(store.get<SessionGroups>(keys.groups(deviceId)) ?? {})
      .flat()
      .map((id) => store.get<SessionSummary>(keys.summary(deviceId, id)))
      .filter((session) => session?.status === 'waiting' || session?.unread).length
  assert.ok(expected('local') > 0)
  assert.equal(store.get(keys.attention('local')), expected('local'))
  assert.equal(store.get(keys.attention('nas')), 0)
  const seen: [string, string | undefined, string][] = []
  const stop = replica.onSessionUpdate((deviceId, before, after) => {
    if (after.id === 's3') seen.push([deviceId, before?.status, after.status])
  })
  await channel.command('session.markRead', { deviceId: 'local', sessionId: 's3' })
  time.advance(16)
  await settle()
  assert.equal(store.get(keys.attention('local')), expected('local'))
  await channel.command('session.send', { deviceId: 'local', sessionId: 's3', text: '在吗' })
  time.advance(16)
  await settle()
  assert.ok(
    seen.some(
      ([deviceId, before, after]) =>
        deviceId === 'local' && before === 'idle' && after === 'running',
    ),
  )
  stop()
  const count = seen.length
  time.advance(60_000)
  await settle()
  assert.equal(seen.length, count, '取消之后不再通知')
})

test('各组的状况：几个待审批、待回答、在跑、未读；只记有事的组，数没变不惊动订阅者', async () => {
  const { store, channel, time, count } = await setup()
  const tallies = (deviceId: string) => store.get<GroupTallies>(keys.tallies(deviceId))
  const tally = (approval: number, answer: number, running: number, unread: number) => ({
    approval,
    answer,
    running,
    unread,
    background: 0,
  })
  // 本机：litch 里 Claude Code 的一个在跑、一个等审批，Pi 的一个未读；docs 里 Pi 的一个未读。
  // 按 harness 分开记。置顶的、分区里的、无工作区的都闲着，不占一项
  assert.deepEqual(tallies('local'), {
    litch: { claude: tally(1, 0, 1, 0), pi: tally(0, 0, 0, 1) },
    docs: { pi: tally(0, 0, 0, 1) },
  })
  // 等回答的和等审批的分开记；出了错的不算在里面
  assert.deepEqual(tallies('build'), { litch2: { claude: tally(0, 1, 0, 0) } })
  assert.deepEqual(tallies('nas'), {})
  // 没连上的设备：会话是上次留下的，都闲着
  assert.deepEqual(tallies('gpu'), {})

  // 把会话置顶：它的状况跟着到置顶那一组去
  await channel.command('session.place', { deviceId: 'local', sessionId: 's3', place: 'pinned' })
  time.advance(16)
  await settle()
  assert.deepEqual(tallies('local'), {
    litch: { claude: tally(1, 0, 1, 0) },
    docs: { pi: tally(0, 0, 0, 1) },
    [PINNED]: { pi: tally(0, 0, 0, 1) },
  })

  // 标成已读：未读少一个，空了的那一组不留着
  await channel.command('session.markRead', { deviceId: 'local', sessionId: 's3' })
  time.advance(16)
  await settle()
  assert.equal(tallies('local')?.[PINNED], undefined)

  // 改个名字不动这几个数：订阅它的那一行不重画
  const seen = count(keys.tallies('local'))
  await channel.command('session.rename', { deviceId: 'local', sessionId: 's4', title: '换个名字' })
  time.advance(16)
  await settle()
  assert.equal(store.get<SessionSummary>(keys.summary('local', 's4'))?.title, '换个名字')
  assert.equal(seen.n, 0)

  // 在闲着的会话里发一句：它那一组多一个在跑的
  await channel.command('session.send', { deviceId: 'local', sessionId: 's6', text: '在吗' })
  time.advance(16)
  await settle()
  assert.deepEqual(tallies('local')?.docs, { claude: tally(0, 0, 1, 0), pi: tally(0, 0, 0, 1) })
  assert.ok(seen.n >= 1)
})

test('各组的状况比较：只剩后台任务在跑的数变了也算变了', () => {
  const tally = (unread: number, background: number) => ({
    approval: 0,
    answer: 0,
    running: 0,
    unread,
    background,
  })
  // 同一组同一个 harness 里有个未读的会话，另一个会话的后台任务跑起来了：其余几个数都没变
  assert.equal(sameTallies({ docs: { pi: tally(1, 0) } }, { docs: { pi: tally(1, 1) } }), false)
  // 键的先后不算数
  assert.equal(
    sameTallies(
      { docs: { pi: tally(1, 1), claude: tally(0, 1) } },
      { docs: { claude: tally(0, 1), pi: tally(1, 1) } },
    ),
    true,
  )
})

test('每个会话属于哪个 harness：一张表，会话多了少了才换', async () => {
  const { store, channel, time, count } = await setup()
  const harnessOf = (deviceId: string) => store.get<SessionHarnesses>(keys.harnessOf(deviceId))
  assert.deepEqual(harnessOf('build'), {
    b1: 'claude',
    b2: 'pi',
    b3: 'claude',
    b4: 'dsh',
    b5: 'claude',
    b6: 'codex',
  })
  assert.equal(Object.keys(harnessOf('local') ?? {}).length, 22)
  assert.deepEqual(harnessOf('nas'), { n1: 'codex' })

  // 会话的状态、标题变了不动这张表
  const seen = count(keys.harnessOf('local'))
  await channel.command('session.markRead', { deviceId: 'local', sessionId: 's3' })
  await channel.command('session.rename', { deviceId: 'local', sessionId: 's4', title: '换个名字' })
  time.advance(16)
  await settle()
  assert.equal(seen.n, 0)

  // 删掉一个：表里没有它了
  await channel.command('session.delete', { deviceId: 'local', sessionId: 's8' })
  time.advance(16)
  await settle()
  assert.equal(harnessOf('local')?.s8, undefined)
  assert.equal(Object.keys(harnessOf('local') ?? {}).length, 21)
  assert.equal(seen.n, 1)
})

test('标成已读：只通知这一个会话的订阅者，列表不重画', async () => {
  const { store, channel, time, count } = await setup()
  const row = count(keys.summary('local', 's3'))
  const other = count(keys.summary('local', 's2'))
  const list = count(keys.groups('local'))
  await channel.command('session.markRead', { deviceId: 'local', sessionId: 's3' })
  time.advance(16)
  await settle()
  assert.equal(store.get<SessionSummary>(keys.summary('local', 's3'))?.unread, false)
  assert.deepEqual([row.n, other.n, list.n], [1, 0, 0])
})

test('打开进行中的会话：文本增量只通知那一个条目', async () => {
  const { store, replica, time, count } = await setup()
  const { deviceId, sessionId, turnId, itemId } = STREAM_SESSION
  const close = replica.openSession(deviceId, sessionId)
  await settle()
  const item = () => store.get<AgentMessageItem>(keys.item(deviceId, sessionId, itemId))
  assert.equal(item()?.text, STREAM_HEAD)
  assert.equal(store.get<string[]>(keys.turnIds(deviceId, sessionId))?.length, 10)

  const itemHits = count(keys.item(deviceId, sessionId, itemId))
  const turnHits = count(keys.turn(deviceId, sessionId, turnId))
  const turnsHits = count(keys.turnIds(deviceId, sessionId))
  const listHits = count(keys.groups(deviceId))
  time.advance(200)
  await settle()
  assert.ok(itemHits.n >= 1)
  assert.ok((item()?.text.length ?? 0) > STREAM_HEAD.length)
  assert.deepEqual([turnHits.n, turnsHits.n, listHits.n], [0, 0, 0])

  const done = () =>
    store.get<TurnView>(keys.turn(deviceId, sessionId, turnId))?.status === 'completed'
  for (let i = 0; i < 2000 && !done(); i++) {
    time.advance(20)
    await settle()
  }
  assert.equal(item()?.text, STREAM_HEAD + STREAM_REST)
  assert.equal(item()?.status, 'completed')
  assert.equal(turnHits.n, 1, '回合只在结束时变一次')
  assert.equal(turnsHits.n, 0)
  time.advance(16)
  await settle()
  assert.equal(store.get<SessionSummary>(keys.summary(deviceId, sessionId))?.status, 'idle')
  assert.equal(listHits.n, 0, '顺序没变，列表不该重画')
  close()
})

test('同一个会话打开两次：全部关掉之后才清掉内容', async () => {
  const { store, replica } = await setup()
  const first = replica.openSession('local', 's4')
  const second = replica.openSession('local', 's4')
  await settle()
  assert.ok(store.get(keys.session('local', 's4')))
  // 元信息里带着分叉来源：样例会话都不是分出来的
  assert.equal(store.get<SessionMeta>(keys.session('local', 's4'))?.forkedFrom, null)
  first()
  first()
  assert.ok(store.get(keys.session('local', 's4')), '还有一处开着')
  second()
  assert.equal(store.get(keys.session('local', 's4')), undefined)
  assert.equal(store.get(keys.turnIds('local', 's4')), undefined)
})

test('停止后：侧栏的数据清掉', async () => {
  const { store, stop } = await setup()
  stop()
  assert.equal(store.get(keys.groups('local')), undefined)
  assert.equal(store.get(keys.summary('local', 's1')), undefined)
})

test('管理数据：打开才有；结构和值分开放，值变了不惊动结构；全部关掉之后清掉', async () => {
  const { store, replica, channel, time, count } = await setup()
  assert.equal(store.get(keys.manage('local')), undefined, '没打开就不去订阅')
  const first = replica.openManage('local')
  const second = replica.openManage('local')
  await settle()
  const schema = store.get<ManageSchema>(keys.manage('local'))
  assert.ok(schema && schema.settings.length > 0 && schema.groups.length > 0)
  const snapshot = () => store.get<SettingsSnapshotView>(keys.manageSnapshot('local'))
  const revisions = () => store.get<ManageRevisions>(keys.manageRevisions('local'))
  assert.deepEqual(revisions(), {}, '刚打开，哪一项都没被动过')

  const schemaHits = count(keys.manage('local'))
  const valueHits = count(keys.manageSnapshot('local'))
  const version = snapshot()?.version ?? 0
  await channel.command('device.settings.write', {
    deviceId: 'local',
    expectedVersion: version,
    edits: [
      { key: 'terminal.scrollback', value: 5000 },
      { key: 'ssh.dsh.enabled', value: true },
    ],
  })
  time.advance(16)
  await settle()
  assert.equal(snapshot()?.values['terminal.scrollback'], 5000)
  assert.equal(snapshot()?.version, version + 1)
  assert.deepEqual(revisions(), { 'terminal.scrollback': 1, 'ssh.dsh.enabled': 1 })
  assert.equal(schemaHits.n, 0, '结构没变，按结构画的那些不该重画')
  assert.ok(valueHits.n > 0)

  await channel.command('device.settings.write', {
    deviceId: 'local',
    expectedVersion: version + 1,
    edits: [{ key: 'terminal.scrollback', value: 6000 }],
  })
  time.advance(16)
  await settle()
  assert.deepEqual(revisions(), { 'terminal.scrollback': 2, 'ssh.dsh.enabled': 1 })

  first()
  first()
  assert.ok(store.get(keys.manage('local')), '还有一处开着')
  second()
  assert.equal(store.get(keys.manage('local')), undefined)
  assert.equal(snapshot(), undefined)
  assert.equal(revisions(), undefined)
})

test('管理数据：订阅不上的，把原因放在它自己的键上；没连上的设备什么都没有，也不算错', async () => {
  const { store, replica } = await setup()
  const nas = replica.openManage('nas')
  const gpu = replica.openManage('gpu')
  await settle()
  assert.equal(store.get<ChannelErrorShape>(keys.manageError('nas'))?.code, 'unsupported')
  assert.equal(store.get(keys.manage('nas')), undefined)
  assert.equal(store.get(keys.manageError('gpu')), undefined)
  assert.equal(store.get(keys.manage('gpu')), undefined)
  nas()
  gpu()
  assert.equal(store.get(keys.manageError('nas')), undefined)
})

test('管理数据：设备服务多了一项设置，结构换一份新的，手上的值和动过的次数照旧', async () => {
  const { store, replica, channel, time } = await setup()
  const close = replica.openManage('local')
  await settle()
  const version = store.get<SettingsSnapshotView>(keys.manageSnapshot('local'))?.version ?? 0
  await channel.command('device.settings.write', {
    deviceId: 'local',
    expectedVersion: version,
    edits: [{ key: 'terminal.scrollback', value: 5000 }],
  })
  await channel.command('session.send', {
    deviceId: 'local',
    sessionId: 's4',
    text: '加一项设置',
  })
  time.advance(16)
  await settle()
  const schema = store.get<ManageSchema>(keys.manage('local'))
  assert.ok(schema?.settings.some((entry) => entry.key === 'harness.dsh.startupNote'))
  assert.equal(
    store.get<SettingsSnapshotView>(keys.manageSnapshot('local'))?.values['terminal.scrollback'],
    5000,
  )
  assert.equal(
    store.get<ManageRevisions>(keys.manageRevisions('local'))?.['terminal.scrollback'],
    1,
  )
  close()
})
