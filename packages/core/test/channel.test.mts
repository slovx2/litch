import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type AbortSignalLike,
  ChannelError,
  type CoreHost,
  connectChannel,
  createOpQueue,
  createPortPair,
  type HostSink,
  type SessionOp,
  type SessionView,
  serveChannel,
} from '../src/index.mjs'
import { ALL_ABLE } from '../src/projection/session.mjs'
import { fakeClock, settle } from './helpers.mjs'

const sessionTopic = { kind: 'session', deviceId: 'd', sessionId: 's' } as const

function emptySession(): SessionView {
  return {
    deviceId: 'd',
    sessionId: 's',
    title: 't',
    harness: 'pi',
    cwd: '~',
    live: true,
    note: null,
    turns: [],
    items: {},
    requests: [],
    queued: [],
    settings: { model: null, effort: null, permission: null, mode: null },
    usage: null,
    can: { ...ALL_ABLE },
    forkedFrom: null,
    proposals: [],
    agents: [],
  }
}

function setup(host: Partial<CoreHost>) {
  const time = fakeClock()
  const [uiPort, corePort] = createPortPair()
  const full: CoreHost = {
    command: host.command ?? (async () => ({})),
    subscribe: host.subscribe ?? (() => () => {}),
  }
  const stop = serveChannel(corePort, full, { clock: time.clock })
  return { channel: connectChannel(uiPort), time, stop }
}

test('命令：一问一答', async () => {
  const { channel } = setup({
    async command(name, params) {
      assert.equal(name, 'core.info')
      assert.deepEqual(params, {})
      return { version: '1.2.3', mock: true }
    },
  })
  assert.deepEqual(await channel.command('core.info', {}), { version: '1.2.3', mock: true })
})

test('命令：核心抛出的错误带着错误码回到界面', async () => {
  const { channel } = setup({
    async command(name) {
      if (name === 'core.info') throw new ChannelError('notFound', '没有')
      throw new Error('炸了')
    },
  })
  await assert.rejects(channel.command('core.info', {}), { code: 'notFound', message: '没有' })
  await assert.rejects(channel.command('session.markRead', { deviceId: 'd', sessionId: 's' }), {
    code: 'internal',
    message: '炸了',
  })
})

test('命令：取消后界面立刻结束，核心那边收到取消信号', async () => {
  let seen: AbortSignalLike | null = null
  const { channel } = setup({
    command(_name, _params, signal) {
      seen = signal
      return new Promise(() => {})
    },
  })
  const controller = new AbortController()
  const pending = channel.command('core.info', {}, { signal: controller.signal })
  await settle()
  controller.abort()
  await assert.rejects(pending, { code: 'cancelled' })
  await settle()
  assert.equal((seen as AbortSignalLike | null)?.aborted, true)
})

test('命令：已经取消的信号不会发出请求', async () => {
  let calls = 0
  const { channel } = setup({
    async command() {
      calls++
      return {}
    },
  })
  await assert.rejects(channel.command('core.info', {}, { signal: AbortSignal.abort() }), {
    code: 'cancelled',
  })
  await settle()
  assert.equal(calls, 0)
})

test('订阅：先快照，后增量；一帧内的多段文本合成一条', async () => {
  let sink: HostSink | null = null
  const { channel, time } = setup({
    subscribe(_topic, hostSink) {
      sink = hostSink
      hostSink.snapshot(emptySession())
      return () => {}
    },
  })
  const events: unknown[] = []
  channel.subscribe(sessionTopic, {
    snapshot: (data) => events.push(['snap', data.sessionId]),
    delta: (ops) => events.push(['delta', ops]),
  })
  await settle()
  assert.deepEqual(events, [['snap', 's']])

  const append = (text: string): SessionOp => ({
    op: 'item.appendText',
    itemId: 'a',
    field: 'text',
    text,
  })
  const live = sink as HostSink | null
  live?.delta([append('你')])
  live?.delta([append('好')])
  live?.delta([{ op: 'item.status', itemId: 'a', status: 'completed' }])
  await settle()
  assert.equal(events.length, 1, '这一帧还没过完，增量不该发出去')

  time.advance(16)
  await settle()
  assert.deepEqual(events[1], [
    'delta',
    [
      { op: 'item.appendText', itemId: 'a', field: 'text', text: '你好' },
      { op: 'item.status', itemId: 'a', status: 'completed' },
    ],
  ])
})

test('订阅：增量是值，交给通道之后核心再改手里的对象，排着队的那一条不跟着变', async () => {
  let sink: HostSink | null = null
  const { channel, time } = setup({
    subscribe(_topic, hostSink) {
      sink = hostSink
      hostSink.snapshot(emptySession())
      return () => {}
    },
  })
  const got: SessionOp[] = []
  channel.subscribe(sessionTopic, { snapshot() {}, delta: (ops) => got.push(...ops) })
  await settle()

  const item = {
    id: 'a',
    kind: 'agentMessage',
    text: '',
    phase: 'final',
    status: 'inProgress',
  } as const
  const turn = {
    id: 't',
    status: 'running',
    itemIds: [] as string[],
    startedAt: 1,
    durationMs: null,
    error: null,
  } as const
  const add: SessionOp[] = [
    { op: 'turn.add', turn },
    { op: 'item.add', turnId: 't', item },
  ]
  ;(sink as HostSink | null)?.delta(add)
  // 这一帧还没过完，核心接着干活：往这个条目上加了字，回合里多了条目
  const mine = item as { text: string; status: string }
  mine.text = '后来才有的字'
  mine.status = 'completed'
  turn.itemIds.push('a')
  await settle()
  time.advance(16)
  await settle()
  assert.deepEqual(got, [
    {
      op: 'turn.add',
      turn: {
        id: 't',
        status: 'running',
        itemIds: [],
        startedAt: 1,
        durationMs: null,
        error: null,
      },
    },
    {
      op: 'item.add',
      turnId: 't',
      item: { id: 'a', kind: 'agentMessage', text: '', phase: 'final', status: 'inProgress' },
    },
  ])
})

test('合并增量：放进队列的是拷出来的一份，不是交进来的那个对象', () => {
  const ops = createOpQueue()
  const item = { id: 'a', kind: 'plan', text: '' }
  const first = { op: 'item.add', turnId: 't', item }
  const more = { op: 'item.appendText', itemId: 'a', field: 'text', text: '一' }
  ops.push([first, more])
  ops.push([{ op: 'item.appendText', itemId: 'a', field: 'text', text: '二' }])
  item.text = '一二'
  const queue = ops.take()
  assert.notEqual(queue[0], first)
  assert.deepEqual(queue, [
    { op: 'item.add', turnId: 't', item: { id: 'a', kind: 'plan', text: '' } },
    { op: 'item.appendText', itemId: 'a', field: 'text', text: '一二' },
  ])
  assert.deepEqual(more, { op: 'item.appendText', itemId: 'a', field: 'text', text: '一' })
})

test('订阅：退订后核心那边的订阅被关掉，之后的增量不再送达', async () => {
  let sink: HostSink | null = null
  let closed = 0
  const { channel, time } = setup({
    subscribe(_topic, hostSink) {
      sink = hostSink
      hostSink.snapshot(emptySession())
      return () => {
        closed++
      }
    },
  })
  let deltas = 0
  const unsubscribe = channel.subscribe(sessionTopic, { snapshot() {}, delta: () => deltas++ })
  await settle()
  ;(sink as HostSink | null)?.delta([{ op: 'item.status', itemId: 'a', status: 'completed' }])
  unsubscribe()
  await settle()
  time.advance(100)
  await settle()
  assert.equal(closed, 1)
  assert.equal(deltas, 0)
  assert.equal(time.pending(), 0, '退订后不该留着定时器')
})

test('订阅：主题不存在时界面收到错误', async () => {
  const { channel } = setup({
    subscribe() {
      throw new ChannelError('notFound', '没有这个会话')
    },
  })
  const errors: string[] = []
  channel.subscribe(sessionTopic, {
    snapshot() {},
    delta() {},
    error: (error) => errors.push(error.code),
  })
  await settle()
  assert.deepEqual(errors, ['notFound'])
})

test('核心一侧停止服务：进行中的命令被取消，订阅全部退掉', async () => {
  let signal: AbortSignalLike | null = null
  let closed = 0
  const { channel, stop } = setup({
    command(_name, _params, commandSignal) {
      signal = commandSignal
      return new Promise(() => {})
    },
    subscribe(_topic, hostSink) {
      hostSink.snapshot(emptySession())
      return () => {
        closed++
      }
    },
  })
  channel.command('core.info', {}).catch(() => {})
  channel.subscribe(sessionTopic, { snapshot() {}, delta() {} })
  await settle()
  stop()
  assert.equal((signal as AbortSignalLike | null)?.aborted, true)
  assert.equal(closed, 1)
})

test('界面一侧关闭通道：等待中的命令以 closed 结束', async () => {
  const { channel } = setup({ command: () => new Promise(() => {}) })
  const pending = channel.command('core.info', {})
  channel.close()
  await assert.rejects(pending, { code: 'closed' })
  await assert.rejects(channel.command('core.info', {}), { code: 'closed' })
})

test('合并增量：同一条目同一字段的追加文本并起来，中间隔着别的增量也并，只有整个换掉这个条目的不跨', () => {
  const ops = createOpQueue()
  const added = (text: string) => ({
    op: 'item.add',
    turnId: 't',
    item: { id: 'b', kind: 'plan', text },
  })
  ops.push([
    { op: 'item.appendText', itemId: 'a', field: 'text', text: '1' },
    { op: 'item.appendText', itemId: 'a', field: 'text', text: '2' },
    { op: 'item.appendText', itemId: 'a', field: 'output', text: 'x' },
    { op: 'item.appendText', itemId: 'b', field: 'output', text: 'y' },
    { op: 'item.status', itemId: 'a', status: 'completed' },
    { op: 'item.appendText', itemId: 'b', field: 'output', text: 'z' },
    { op: 'item.appendText', itemId: 'a', field: 'output', text: 'w' },
    added('整个换掉'),
    { op: 'item.appendText', itemId: 'b', field: 'output', text: '之后' },
  ])
  assert.deepEqual(ops.take(), [
    { op: 'item.appendText', itemId: 'a', field: 'text', text: '12' },
    { op: 'item.appendText', itemId: 'a', field: 'output', text: 'xw' },
    { op: 'item.appendText', itemId: 'b', field: 'output', text: 'yz' },
    { op: 'item.status', itemId: 'a', status: 'completed' },
    added('整个换掉'),
    { op: 'item.appendText', itemId: 'b', field: 'output', text: '之后' },
  ])
  // 取走之后从头算
  ops.push([{ op: 'item.appendText', itemId: 'a', field: 'text', text: '3' }])
  assert.deepEqual(ops.take(), [{ op: 'item.appendText', itemId: 'a', field: 'text', text: '3' }])
  assert.equal(ops.length, 0)
})

test('同线程端口：发出的消息是拷贝，事后改原对象不影响对面', async () => {
  const [a, b] = createPortPair()
  const received: unknown[] = []
  b.listen((message) => received.push(message))
  const message = { text: '原来的' }
  a.post(message)
  message.text = '改过的'
  await settle()
  assert.deepEqual(received, [{ text: '原来的' }])
})
