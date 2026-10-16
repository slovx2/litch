// 侧栏跟着别处的动静走：别处建的、还没说过话的会话，没打开的会话有了新回合，第一个回合里的标题，
// 未读记号重启之后还在。对着假对端跑，侧栏的数据像界面那样把快照和增量落下来。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Thread } from '../../protocol/src/index.mjs'
import {
  checkSnapshot,
  createCore,
  type DeviceSnapshot,
  type SessionSummary,
  type SidebarOp,
  type SidebarView,
} from '../src/index.mjs'
import { fakeOpener, type Handler, RpcFailure } from './fake-server.mjs'
import { thread, turn } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'
import { runtimeInfo } from './world.mjs'

const never = { aborted: false, addEventListener() {} }

function setup(threads: Thread[], remembered: DeviceSnapshot | null = null) {
  const world = {
    threads,
    /**
     * 设备上有、线程列表里不列的会话：上游的列表不列还没说过话的（preview 是空的）会话，
     * 按标识读得到（thread/read 对加载着的会话用内存里的那份）
     */
    unlisted: [] as Thread[],
    /** thread/start 应答之前先发一条会话开始的通知（适配器的 Claude Code 入口是这个顺序） */
    startedFirst: false,
  }
  const find = (params: unknown): Thread => {
    const { threadId } = params as { threadId: string }
    const found = [...world.threads, ...world.unlisted].find((entry) => entry.id === threadId)
    if (!found) throw new RpcFailure(-32600, `thread not found: ${threadId}`)
    return found
  }
  const handlers: Record<string, Handler> = {
    'runtime/info': () => runtimeInfo(),
    'project/list': () => ({ data: [], nextCursor: null }),
    'thread/list': () => ({
      data: world.threads.map((entry) => ({ ...entry, turns: [] })),
      nextCursor: null,
      backwardsCursor: null,
    }),
    'thread/read': (params) => ({ thread: { ...find(params), turns: [] } }),
    'thread/resume': (params) => ({ thread: find(params) }),
    'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
    'thread/start': () => {
      const created = thread({ id: `new-${world.threads.length}`, status: { type: 'idle' } })
      world.threads.push(created)
      if (world.startedFirst) peer.last().notify('thread/started', { thread: created })
      return { thread: created, model: 'gate/small', reasoningEffort: null }
    },
    'turn/start': () => ({ turn: turn('t-new', [], { status: 'inProgress' }) }),
  }
  const time = fakeClock()
  const peer = fakeOpener(handlers)
  const saved: DeviceSnapshot[] = []
  const core = createCore({
    clock: time.clock,
    version: '9.9.9',
    store: {
      load: () => ({ localWire: null, remotes: [] }),
      save() {},
      snapshot: () => ({
        load: () => remembered,
        // 像外壳那样过一遍 JSON 再记着
        save: (snapshot) => saved.push(JSON.parse(JSON.stringify(snapshot)) as DeviceSnapshot),
      }),
      forget() {},
    },
    devices: [
      {
        id: 'local',
        name: '本机',
        host: 'dev@mac',
        kind: 'local',
        target: null,
        wire: 'green',
        open: peer.open,
      },
    ],
  })
  /** 侧栏：像界面那样把快照和增量落下来 */
  const side = new Map<string, SessionSummary>()
  core.subscribe(
    { kind: 'sidebar', deviceId: 'local' },
    {
      snapshot(data) {
        side.clear()
        for (const entry of (data as SidebarView).sessions) side.set(entry.id, entry)
      },
      delta(ops) {
        for (const op of ops as SidebarOp[]) {
          if (op.op === 'session.upsert') side.set(op.session.id, op.session)
          else if (op.op === 'session.remove') side.delete(op.sessionId)
        }
      },
      error() {},
    },
  )
  const command = (name: string, params: object) => core.command(name, params, never)
  const sent = (method: string) =>
    peer
      .last()
      .seen.filter((entry) => entry.method === method)
      .map((entry) => entry.params)
  /** 侧栏里的会话，按界面的排法（最近动过的在前）：标识 */
  const order = () =>
    [...side.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((entry) => entry.id)
  return { core, world, peer, time, side, saved, command, sent, order }
}

const where = (sessionId: string) => ({ deviceId: 'local', sessionId })

test('未读记号存在侧栏的快照里：重启之后还在，读过的、设备上没了的不留', async () => {
  const first = setup([
    thread({ id: 'a', preview: '甲', updatedAt: 1_700_000_100 }),
    thread({ id: 'b', preview: '乙', updatedAt: 1_700_000_050 }),
    thread({ id: 'c', preview: '丙', updatedAt: 1_700_000_010 }),
  ])
  first.core.start()
  await settle()
  const server = first.peer.last()
  // 三个会话都在别处跑完了一个回合，界面上都没开着：都标成未读
  for (const id of ['a', 'b', 'c']) {
    server.notify('thread/status/changed', {
      threadId: id,
      status: { type: 'active', activeFlags: [] },
    })
    server.notify('thread/status/changed', { threadId: id, status: { type: 'idle' } })
  }
  await settle()
  assert.deepEqual(
    [...first.side.values()].filter((entry) => entry.unread).map((entry) => entry.id),
    ['a', 'b', 'c'],
  )
  // 读过一个：快照里跟着少一个
  await first.command('session.markRead', where('b'))
  first.time.advance(5_000)
  await settle()
  const kept = first.saved.at(-1)
  assert.ok(kept, '应该记过快照')
  assert.deepEqual([...(kept.unread ?? [])].sort(), ['a', 'c'])
  assert.deepEqual(checkSnapshot(kept)?.unread, kept.unread)
  first.core.stop()

  // 重启：没连上之前摆出来的上次的内容就带着未读；c 在这期间被别处删了
  const second = setup(
    [
      thread({ id: 'a', preview: '甲', updatedAt: 1_700_000_100 }),
      thread({ id: 'b', preview: '乙', updatedAt: 1_700_000_050 }),
    ],
    kept,
  )
  second.peer.failures.push(new Error('还连不上'))
  second.core.start()
  await settle()
  assert.equal(second.side.get('a')?.unread, true)
  assert.equal(second.side.get('b')?.unread, false)
  assert.equal(second.side.get('c')?.unread, true)
  // 连上、对过账：a 还是未读，c 没了；记下来的也只剩 a
  second.time.advance(1_000)
  await settle()
  await settle()
  assert.equal(second.side.get('a')?.unread, true)
  assert.equal(second.side.has('c'), false)
  second.time.advance(5_000)
  await settle()
  assert.deepEqual(second.saved.at(-1)?.unread, ['a'])
  // 打开它就算读过了，记下来的也跟着空了
  await second.command('session.markRead', where('a'))
  second.time.advance(5_000)
  await settle()
  assert.deepEqual(second.saved.at(-1)?.unread, [])
})

/** 协议里的秒 */
const seconds = (ms: number) => Math.floor(ms / 1000)

test('别处建的、还没说过话的会话不进侧栏：开始第一个回合才放进来，带着第一句话当标题', async () => {
  const { core, world, peer, side, sent } = setup([thread({ id: 'a', preview: '早先的' })])
  core.start()
  await settle()
  const server = peer.last()
  // 官方桌面端在新对话页上先建好一个会话，还没发消息：会话开始的通知发给所有连接，preview 是空的
  const warm = thread({ id: 'w', status: { type: 'idle' } })
  world.unlisted.push(warm)
  server.notify('thread/started', { thread: warm })
  await settle()
  assert.deepEqual([...side.keys()], ['a'])
  // 一直没用：没人订阅之后卸载（先报状态成了 notLoaded，再发关闭），或者被那边删掉。都不去要它的信息
  for (const id of ['z', 'gone']) {
    const idle = thread({ id, status: { type: 'idle' } })
    world.unlisted.push(idle)
    server.notify('thread/started', { thread: idle })
  }
  server.notify('thread/status/changed', { threadId: 'z', status: { type: 'notLoaded' } })
  server.notify('thread/closed', { threadId: 'z' })
  server.notify('thread/deleted', { threadId: 'gone' })
  await settle()
  assert.deepEqual([...side.keys()], ['a'])
  assert.deepEqual(sent('thread/read'), [])
  // 起了名字就有了标题：放进来
  const named = thread({ id: 'n', status: { type: 'idle' } })
  world.unlisted.push(named)
  server.notify('thread/started', { thread: named })
  named.name = '先起好的名字'
  server.notify('thread/name/updated', { threadId: 'n', threadName: '先起好的名字' })
  await settle()
  await settle()
  assert.equal(side.get('n')?.title, '先起好的名字')

  // 在那边发了第一句：第一句话记下了，状态变成在跑。这时放进侧栏，标题就是那句话，不等回合结束
  warm.preview = '帮我看看构建为什么挂了'
  warm.status = { type: 'active', activeFlags: [] }
  server.notify('thread/status/changed', {
    threadId: 'w',
    status: { type: 'active', activeFlags: [] },
  })
  await settle()
  await settle()
  assert.equal(side.get('w')?.title, '帮我看看构建为什么挂了')
  assert.equal(side.get('w')?.status, 'running')
  assert.deepEqual(
    sent('thread/read').map((params) => (params as { threadId: string }).threadId),
    ['n', 'w'],
  )
})

test('自己建的会话：会话开始的通知先于应答到，侧栏里照样有它', async () => {
  const { core, world, side, command } = setup([thread({ id: 'a', preview: '早先的' })])
  world.startedFirst = true
  core.start()
  await settle()
  const { sessionId } = (await command('session.create', {
    deviceId: 'local',
    cwd: null,
    text: '新开一个',
  })) as { sessionId: string }
  await settle()
  assert.equal(side.get(sessionId)?.title, '新开一个')
})

test('没打开的会话在别处跑了新回合：侧栏上的时间跟着回合的开始和结束走，排到前面', async () => {
  const { core, peer, side, time, order } = setup([
    thread({ id: 'a', preview: '甲', updatedAt: 1_700_000_100 }),
    thread({ id: 'b', preview: '乙', updatedAt: 1_700_000_200 }),
  ])
  core.start()
  await settle()
  assert.deepEqual(order(), ['b', 'a'])
  // 一小时之后，a 在官方桌面端里开始了一个回合。没订阅它，收得到的只有发给所有连接的状态变化
  time.advance(3_600_000)
  const server = peer.last()
  // 只是被谁打开（载入）了，不算有动静
  server.notify('thread/status/changed', { threadId: 'a', status: { type: 'idle' } })
  await settle()
  assert.deepEqual(order(), ['b', 'a'])
  const begun = time.clock.now()
  server.notify('thread/status/changed', {
    threadId: 'a',
    status: { type: 'active', activeFlags: [] },
  })
  await settle()
  assert.deepEqual(order(), ['a', 'b'])
  assert.equal(side.get('a')?.updatedAt, seconds(begun) * 1000)
  // 停下来等审批、审批过了接着跑：回合还没完，不算
  time.advance(60_000)
  server.notify('thread/status/changed', {
    threadId: 'a',
    status: { type: 'active', activeFlags: ['waitingOnApproval'] },
  })
  await settle()
  assert.equal(side.get('a')?.updatedAt, seconds(begun) * 1000)
  // 十分钟后回合结束：时间是结束的那一刻，标成未读
  time.advance(600_000)
  server.notify('thread/status/changed', { threadId: 'a', status: { type: 'idle' } })
  await settle()
  assert.equal(side.get('a')?.updatedAt, seconds(time.clock.now()) * 1000)
  assert.equal(side.get('a')?.unread, true)
})

test('侧栏上没有标题的会话开始跑了：去要它的第一句话，不等回合结束', async () => {
  // 列表里就有、还没有第一句话的会话（适配器的入口会列出这种会话）
  const empty = thread({ id: 'e', status: { type: 'idle' } })
  const { core, peer, side, sent } = setup([thread({ id: 'a', preview: '甲' }), empty])
  core.start()
  await settle()
  assert.equal(typeof side.get('e')?.title, 'object', '还没有标题：是“没有标题的会话”那一句')
  // 别处在它上面发了第一句
  empty.preview = '第一句话'
  const server = peer.last()
  server.notify('thread/status/changed', {
    threadId: 'e',
    status: { type: 'active', activeFlags: [] },
  })
  await settle()
  await settle()
  assert.equal(side.get('e')?.title, '第一句话')
  // 有标题的会话开始跑不去要
  server.notify('thread/status/changed', {
    threadId: 'a',
    status: { type: 'active', activeFlags: [] },
  })
  await settle()
  assert.deepEqual(sent('thread/read'), [{ threadId: 'e', includeTurns: false }])
})

test('还没说过话的会话开始跑了、第一句话一时还读不到：照样放进侧栏，回合结束时再去要一次', async () => {
  const { core, world, peer, side, sent } = setup([thread({ id: 'a', preview: '甲' })])
  core.start()
  await settle()
  const server = peer.last()
  const warm = thread({ id: 'w', status: { type: 'idle' } })
  world.unlisted.push(warm)
  server.notify('thread/started', { thread: warm })
  // 上游在记下第一句用户消息之后才落盘，宣布回合开始的那一刻按标识读到的可能还是空的
  warm.status = { type: 'active', activeFlags: [] }
  server.notify('thread/status/changed', {
    threadId: 'w',
    status: { type: 'active', activeFlags: [] },
  })
  await settle()
  await settle()
  assert.equal(side.get('w')?.status, 'running')
  warm.preview = '这回读得到了'
  server.notify('thread/status/changed', { threadId: 'w', status: { type: 'idle' } })
  await settle()
  await settle()
  assert.equal(side.get('w')?.title, '这回读得到了')
  assert.equal(side.get('w')?.unread, true)
  assert.equal(sent('thread/read').length, 2)

  // 连上之前就建好了的（没见过它的会话开始通知）也一样
  const before = thread({ id: 'v', status: { type: 'active', activeFlags: [] } })
  world.unlisted.push(before)
  server.notify('thread/status/changed', {
    threadId: 'v',
    status: { type: 'active', activeFlags: [] },
  })
  await settle()
  await settle()
  assert.equal(side.get('v')?.status, 'running')
})
