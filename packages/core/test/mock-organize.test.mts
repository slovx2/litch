// 整理侧栏在界面那一头落成什么样：置顶组、分区组、工作区的顺序。
// 对着模拟核心跑，经真的通道和界面用的那份数据副本——界面的验收脚本看到的就是这些键。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type ChannelError,
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  type DeviceView,
  groupOfSection,
  keys,
  LOOSE,
  PINNED,
  type SessionGroups,
  type SessionSummary,
  type SessionView,
  serveChannel,
  type WorkspaceView,
} from '../src/index.mjs'
import { fakeClock, settle } from './helpers.mjs'

async function setup() {
  const time = fakeClock()
  const [uiPort, corePort] = createPortPair()
  serveChannel(corePort, createMockCore({ clock: time.clock, chunkMs: 10 }), { clock: time.clock })
  const channel = connectChannel(uiPort)
  const replica = createReplica(channel)
  replica.start()
  await settle()
  await settle()
  const { store } = replica
  const groups = (deviceId = 'local') => store.get<SessionGroups>(keys.groups(deviceId)) ?? {}
  const names = (deviceId = 'local') =>
    (store.get<WorkspaceView[]>(keys.workspaces(deviceId)) ?? []).map((entry) => entry.name)
  const summary = (id: string, deviceId = 'local') =>
    store.get<SessionSummary>(keys.summary(deviceId, id))
  /** 过一帧：通道把增量排一帧再发 */
  const frame = async () => {
    time.advance(20)
    await settle()
  }
  const run = async (name: string, params: object) => {
    const result = await channel.command(name as never, { deviceId: 'local', ...params } as never)
    await frame()
    return result as unknown
  }
  return { time, channel, store, groups, names, summary, frame, run }
}

test('置顶：从工作区那一组挪到置顶组，排在先置顶的后面；取消置顶回到原来的工作区', async () => {
  const { groups, summary, run } = await setup()
  assert.deepEqual(groups()[PINNED], ['p1', 'p2'])
  assert.ok(groups().docs?.includes('s6'))

  await run('session.place', { sessionId: 's6', place: 'pinned' })
  assert.deepEqual(groups()[PINNED], ['p1', 'p2', 's6'], '后置顶的在后面，位置是稳的')
  assert.ok(!groups().docs?.includes('s6'), '置顶的不再出现在工作区里')
  assert.equal(summary('s6')?.workspaceId, 'docs', '归属没变')

  await run('session.place', { sessionId: 'p1', place: null })
  assert.deepEqual(groups()[PINNED], ['p2', 's6'])
  assert.ok(groups().litch?.includes('p1'))

  // 自定义分区里的拿出来：回到它的工作区，分区空了就不再列
  assert.deepEqual(groups()[groupOfSection('sec-later')], ['k1'])
  await run('session.place', { sessionId: 'k1', place: null })
  assert.equal(groups()[groupOfSection('sec-later')], undefined)
  assert.ok(groups().litch?.includes('k1'))
})

test('工作区：加、改名换色、调顺序、删；候选目录来自没有归属的会话', async () => {
  const { store, groups, names, summary, run, channel } = await setup()
  assert.deepEqual(await run('workspace.candidates', {}), {
    roots: ['/Users/dev/notes/launchd'],
  })
  const created = (await run('workspace.create', {
    name: 'notes',
    root: '/Users/dev/notes',
    color: 'violet',
  })) as { workspaceId: string }
  assert.deepEqual(names(), ['litch', 'docs-site', 'notes'])
  // 工作目录在它下面的那个没有归属的会话跟着归进去
  assert.equal(summary('s9')?.workspaceId, created.workspaceId)
  assert.deepEqual(groups()[created.workspaceId], ['s9'])
  assert.equal(groups()[LOOSE], undefined)

  await run('workspace.update', { workspaceId: created.workspaceId, name: '笔记', color: null })
  const renamed = store
    .get<WorkspaceView[]>(keys.workspaces('local'))
    ?.find((entry) => entry.id === created.workspaceId)
  assert.deepEqual([renamed?.name, renamed?.color], ['笔记', null])

  await run('workspace.move', { workspaceId: created.workspaceId, before: 'litch' })
  assert.deepEqual(names(), ['笔记', 'litch', 'docs-site'])

  await run('session.move', { sessionId: 's8', workspaceId: created.workspaceId })
  assert.ok(groups()[created.workspaceId]?.includes('s8'))
  assert.ok(!groups().docs?.includes('s8'))

  await run('workspace.delete', { workspaceId: created.workspaceId })
  assert.deepEqual(names(), ['litch', 'docs-site'])
  assert.deepEqual(
    [...(groups()[LOOSE] ?? [])].sort(),
    ['s8', 's9'],
    '会话都还在，回到没有工作区那一组',
  )

  // 名字、目录不合规矩的说得出是哪一句
  const refused = await channel
    .command('workspace.create', { deviceId: 'local', name: 'x', root: 'relative/path' })
    .then(
      () => null,
      (error: ChannelError) => error,
    )
  assert.deepEqual([refused?.code, refused?.text], ['rejected', { key: 'fault.workspaceRoot' }])
})

test('别处整理了侧栏：这边什么都没做，置顶和新工作区靠增量就到了', async () => {
  const { time, channel, groups, names, store } = await setup()
  const before = names()
  await channel.command('session.send', { deviceId: 'local', sessionId: 's7', text: '别处整理' })
  time.advance(2000)
  await settle()
  time.advance(20)
  await settle()
  assert.deepEqual(names(), [...before, '别处建的'])
  assert.ok(groups()[PINNED]?.includes('s7'))
  assert.ok(!groups().docs?.includes('s7'))
  // 没连着的设备整理不了
  assert.equal(store.get<DeviceView>(keys.device('gpu'))?.organizable, false)
  await assert.rejects(
    channel.command('session.place', { deviceId: 'gpu', sessionId: 'g1', place: 'pinned' }),
    { code: 'offline' },
  )
})

test('模拟核心里的声明：dsh 的会话一上来就没有分叉和压缩，Codex 的审批没有写说明的入口', async () => {
  const { channel, time } = await setup()
  const open = (deviceId: string, sessionId: string) => {
    const seen = { view: null as SessionView | null }
    channel.subscribe(
      { kind: 'session', deviceId, sessionId },
      { snapshot: (data) => (seen.view = data), delta() {}, error() {} },
    )
    return seen
  }
  const dsh = open('local', 's4')
  await settle()
  assert.deepEqual([dsh.view?.can.fork, dsh.view?.can.declared], [false, true])

  // Pi 只有一档权限，建好之后换不了
  const pi = await channel.command('device.composeOptions', { deviceId: 'local', harness: 'pi' })
  assert.deepEqual(
    pi.permissions.map((entry) => [entry.id, entry.switchable]),
    [[':danger-full-access', false]],
  )

  await channel.command('session.send', { deviceId: 'build', sessionId: 'b6', text: '审批' })
  time.advance(100)
  await settle()
  let asked: SessionView | null = null
  channel.subscribe(
    { kind: 'session', deviceId: 'build', sessionId: 'b6' },
    { snapshot: (data) => (asked = data), delta() {}, error() {} },
  )
  await settle()
  const request = (asked as SessionView | null)?.requests[0]
  assert.equal(request?.kind, 'approval')
  if (request?.kind !== 'approval') return
  assert.deepEqual(request.options, [
    { id: 'accept', role: 'accept' },
    { id: 'acceptAlways', role: 'acceptAlways', rule: 'curl -fsSL' },
    { id: 'decline', role: 'decline' },
    { id: 'cancel', role: 'cancel' },
  ])
})
