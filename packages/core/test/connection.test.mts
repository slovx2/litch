import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ConnectError,
  createLink,
  createRpc,
  createTransportPair,
  type LinkState,
  type Text,
} from '../src/index.mjs'
import { fakeOpener, INIT, RpcFailure, serveFake } from './fake-server.mjs'
import { fakeClock, settle } from './helpers.mjs'

const CLIENT = { name: 'litch-test', title: null, version: '0.0.0' }

function rpcSetup(handlers: Parameters<typeof serveFake>[1]) {
  const time = fakeClock()
  const [client, server] = createTransportPair()
  const fake = serveFake(server, handlers)
  const notes: unknown[] = []
  const closes: (Text | null)[] = []
  const rpc = createRpc(client, {
    clock: time.clock,
    notification: (method, params) => notes.push([method, params]),
    close: (reason) => closes.push(reason),
  })
  return { rpc, fake, time, notes, closes }
}

test('请求：应答按编号配对，错误带着错误码', async () => {
  const { rpc } = rpcSetup({
    echo: (params) => ({ got: params }),
    boom: () => {
      throw new RpcFailure(-32600, 'Invalid request')
    },
  })
  const [a, b] = await Promise.all([rpc.request('echo', 1), rpc.request('echo', 2)])
  assert.deepEqual([a, b], [{ got: 1 }, { got: 2 }])
  await assert.rejects(rpc.request('boom', {}), { name: 'RpcError', code: -32600 })
  await assert.rejects(rpc.request('nope', {}), { name: 'RpcError', code: -32601 })
})

test('请求：超时、取消、断开都会让等待结束', async () => {
  const { rpc, fake, time, closes } = rpcSetup({ hang: () => undefined })
  const slow = rpc.request('hang', {}, { timeoutMs: 100 })
  await settle()
  time.advance(100)
  await assert.rejects(slow, { reason: 'timeout' })

  const controller = new AbortController()
  const cancelled = rpc.request('hang', {}, { signal: controller.signal })
  controller.abort()
  await assert.rejects(cancelled, { reason: 'cancelled' })

  const dropped = rpc.request('hang', {})
  await settle()
  fake.drop()
  await assert.rejects(dropped, { reason: 'closed' })
  assert.deepEqual(closes, [null])
  await assert.rejects(rpc.request('hang', {}), { reason: 'closed' })
  assert.equal(time.pending(), 0, '结束的请求不该留着定时器')
})

test('通知交给处理函数；对面发来的请求没人处理时也有应答', async () => {
  const { fake, notes } = rpcSetup({})
  fake.notify('thread/started', { thread: { id: 't' } })
  const reply = await fake.ask('item/commandExecution/requestApproval', {})
  assert.deepEqual(notes, [['thread/started', { thread: { id: 't' } }]])
  assert.ok('error' in reply && reply.error.code === -32601)
})

function linkSetup(handlers: Parameters<typeof fakeOpener>[0] = {}) {
  const time = fakeClock()
  const peer = fakeOpener(handlers)
  const states: LinkState[] = []
  const notes: string[] = []
  const link = createLink({
    open: peer.open,
    clock: time.clock,
    clientInfo: CLIENT,
    backoffMs: [100, 200],
    state: (state) => states.push(state),
    notification: (method) => notes.push(method),
  })
  const phases = () => states.map((state) => state.phase)
  // 经函数取状态：直接读 link.state 的话，前面的断言会把它的类型收窄，后面再判断别的阶段就过不了类型检查
  const current = (): LinkState => link.state
  return { link, peer, time, states, phases, current, notes }
}

test('连接：开传输、握手、连上，握手里带着客户端信息', async () => {
  const { link, peer, phases, current } = linkSetup({ ping: () => ({ pong: true }) })
  link.start()
  await settle()
  assert.deepEqual(phases(), ['connecting', 'handshaking', 'connected'])
  assert.deepEqual(current(), { phase: 'connected', info: INIT })
  const seen = peer.last().seen
  assert.equal(seen[0]?.method, 'initialize')
  assert.deepEqual((seen[0]?.params as { clientInfo: unknown } | undefined)?.clientInfo, CLIENT)
  assert.equal(seen[1]?.method, 'initialized')
})

test('连接：连不上就按退避重试，连上后计数清零', async () => {
  const { link, peer, time, states, phases, current } = linkSetup()
  peer.failures.push(new Error('ENOENT'), new ConnectError('unreachable', '没人监听'))
  link.start()
  await settle()
  assert.deepEqual(phases(), ['connecting', 'waiting'])
  const first = states[1]
  assert.ok(first?.phase === 'waiting' && first.attempt === 1)
  assert.equal(first.failure.text, 'ENOENT')
  assert.equal(first.retryAt - time.clock.now(), 100)

  time.advance(100)
  await settle()
  const second = states[states.length - 1]
  assert.ok(second?.phase === 'waiting' && second.attempt === 2)
  assert.equal(second.retryAt - time.clock.now(), 200)

  time.advance(200)
  await settle()
  assert.equal(current().phase, 'connected')

  // 连上之后断开：从头开始退避
  peer.last().drop()
  await settle()
  const dropped = current()
  assert.ok(dropped.phase === 'waiting' && dropped.attempt === 1)
  time.advance(100)
  await settle()
  assert.equal(current().phase, 'connected')
  assert.equal(peer.servers.length, 2)
})

test('连接：不值得重试的失败直接停在失败；手动重试可以再来', async () => {
  const { link, peer, time, phases, current } = linkSetup()
  peer.failures.push(new ConnectError('notInstalled', '对面没有装设备服务', false))
  link.start()
  await settle()
  assert.deepEqual(phases(), ['connecting', 'failed'])
  assert.equal(time.pending(), 0)
  link.retry()
  await settle()
  assert.equal(current().phase, 'connected')
})

test('连接：连着的时候让它重新连一次，这条放下、当场再开一条；没连着时不动', async () => {
  const { link, peer, phases, current } = linkSetup()
  // 还没开始：什么都不做
  link.reopen()
  await settle()
  assert.deepEqual(phases(), [])
  link.start()
  await settle()
  assert.equal(current().phase, 'connected')
  const first = peer.last()

  link.reopen()
  await settle()
  // 不经过“等着重试”：不是出了错，没有退避
  assert.deepEqual(phases(), [
    'connecting',
    'handshaking',
    'connected',
    'connecting',
    'handshaking',
    'connected',
  ])
  assert.equal(peer.servers.length, 2)
  assert.notEqual(peer.last(), first)
  // 新的那条从握手开始
  assert.equal(peer.last().seen[0]?.method, 'initialize')

  // 停在失败上的时候不归它管：那是“重试”的事
  const stuck = linkSetup()
  stuck.peer.failures.push(new ConnectError('notInstalled', '对面没有装设备服务', false))
  stuck.link.start()
  await settle()
  stuck.link.reopen()
  await settle()
  assert.equal(stuck.current().phase, 'failed')
})

test('连接：失败里带着“该给哪一份怎么办”，没给的不带这一项', async () => {
  const guided = linkSetup()
  guided.peer.failures.push(
    new ConnectError('outdated', '适配器太旧', false, '未知命令: version', 'upgradeService'),
  )
  guided.link.start()
  await settle()
  const state = guided.current()
  assert.ok(state.phase === 'failed')
  assert.deepEqual(state.failure, {
    stage: 'outdated',
    text: '适配器太旧',
    detail: '未知命令: version',
    guide: 'upgradeService',
  })

  const plain = linkSetup()
  plain.peer.failures.push(new ConnectError('auth', '登录被拒', false))
  plain.link.start()
  await settle()
  const other = plain.current()
  assert.ok(other.phase === 'failed')
  assert.equal('guide' in other.failure, false)
})

test('连接：对面拒绝握手不重试，握手超时会重试', async () => {
  const refused = linkSetup({
    initialize: () => {
      throw new RpcFailure(-32600, 'unsupported client')
    },
  })
  refused.link.start()
  await settle()
  const state = refused.current()
  assert.ok(state.phase === 'failed' && state.failure.stage === 'handshake')

  const silent = linkSetup({ initialize: () => undefined })
  silent.link.start()
  await settle()
  assert.equal(silent.current().phase, 'handshaking')
  silent.time.advance(10_000)
  await settle()
  const waiting = silent.current()
  assert.ok(waiting.phase === 'waiting' && waiting.failure.stage === 'handshake')
})

test('连接：没连上时请求立刻失败；停止后不再重连', async () => {
  const { link, peer, time, current } = linkSetup()
  await assert.rejects(link.request('thread/list', {}), { reason: 'closed' })
  peer.failures.push(new Error('x'))
  link.start()
  await settle()
  link.stop()
  assert.equal(current().phase, 'idle')
  time.advance(10_000)
  await settle()
  assert.equal(current().phase, 'idle')
  assert.equal(peer.servers.length, 0)
})
