// 设备侧的两样通用件：设备工具的注册表（device-tools.mts）和设备进程自有的引擎连接（engine-link.mts）。
// litch_tasks 是第一个注册者，这里另注册一个命名空间，看注册表这一层的拦截对谁都一样；
// 内部连接收到审批这类请求时：没人可送就当场失败的引擎，没有客户端拿着就替它回“没人可送”，
// 有客户端拿着就留给客户端；没人可送时本来就等着的引擎（Claude）照旧不答。
import assert from 'node:assert/strict'
import test from 'node:test'
import { type ClientToolCallResponse, clientToolFailure } from '../../protocol/src/client-tools.mjs'
import { NO_RECIPIENT_MESSAGE } from '../../shared/src/server-requests.mjs'
import { type DeviceToolCall, DeviceTools } from '../src/device-tools.mjs'
import { EngineUnavailable, runTurn } from '../src/engine-link.mjs'
import type { FakeConnection } from './fake-upstream.mjs'
import { settle } from './helpers.mjs'
import { DECLARED, TaskEngine, taskRig, tasksClient, until } from './task-kit.mjs'

const ok = (text: string): ClientToolCallResponse => ({
  success: true,
  contentItems: [{ type: 'inputText', text }],
})

/** 设备进程自己开的那几条上游连接（握手时报的名字是 litch-device） */
const internal = (engine: TaskEngine): FakeConnection[] =>
  engine.live.filter((connection) => connection.raw[0]?.includes('"name":"litch-device"'))

test('注册表：命名空间要以 litch_ 开头、不能注册两次；同一次调用只答一份；处理函数抛错、没注册的回失败', async () => {
  const tools = new DeviceTools()
  const seen: DeviceToolCall[] = []
  assert.throws(() => tools.register('demo', async () => ok('x')), /litch_/)
  tools.register('litch_demo', async (call) => {
    seen.push(call)
    if (call.tool === 'boom') throw new Error('炸了')
    return ok(`answered ${call.tool}`)
  })
  assert.throws(() => tools.register('litch_demo', async () => ok('x')), /注册过/)
  assert.deepEqual(tools.namespaces(), ['litch_demo'])
  assert.equal(tools.has('litch_demo'), true)
  assert.equal(tools.has('litch_tasks'), false)

  const replies: ClientToolCallResponse[] = []
  const frame = (tool: string, callId: string, namespace = 'litch_demo') => ({
    threadId: 'th',
    turnId: 'tu',
    callId,
    namespace,
    tool,
    arguments: { a: 1 },
  })
  // 原生 codex 的几份：请求号相同、callId 相同，从不同的连接来
  tools.dispatch('codex', frame('echo', 'c1'), (result) => replies.push(result) > 0)
  tools.dispatch('codex', frame('echo', 'c1'), (result) => replies.push(result) > 0)
  await until('答了', () => replies.length === 1)
  await settle(20)
  assert.deepEqual(replies, [ok('answered echo')])
  assert.deepEqual(seen[0], {
    harness: 'codex',
    threadId: 'th',
    turnId: 'tu',
    callId: 'c1',
    namespace: 'litch_demo',
    tool: 'echo',
    arguments: { a: 1 },
  })
  // 别的 harness 上同样的 callId 是另一次调用
  tools.dispatch('pi', frame('echo', 'c1'), (result) => replies.push(result) > 0)
  tools.dispatch('pi', frame('boom', 'c2'), (result) => replies.push(result) > 0)
  tools.dispatch('pi', frame('x', 'c3', 'litch_nope'), (result) => replies.push(result) > 0)
  await until('都答了', () => replies.length === 4)
  // 没注册的当场答，处理函数的结果晚一点：不看先后
  assert.deepEqual(
    new Set(replies.slice(1)),
    new Set([
      ok('answered echo'),
      clientToolFailure('failed', 'litch_demo.boom failed: 炸了'),
      clientToolFailure('invalid', 'litch_nope is not available on this device.'),
    ]),
  )
})

test('另注册一个命名空间：每条通往引擎的连接都替它声明，引擎发来的调用由设备进程答，客户端收不到', async () => {
  const engine = new TaskEngine()
  const target = taskRig({ pi: engine })
  try {
    const calls: DeviceToolCall[] = []
    target.device.deviceTools.register('litch_demo', async (call) => {
      calls.push(call)
      return ok(`demo ${call.tool}`)
    })
    const client = await tasksClient(target)
    const greeting = engine.seen.findLast((item) => item.method === 'initialize')?.params
    // 设备进程自己执行的不看会话：都列进 anyThread
    assert.deepEqual(greeting.capabilities.litchClientTools, {
      namespaces: ['litch_tasks', 'litch_sessions', 'litch_demo'],
      anyThread: ['litch_tasks', 'litch_sessions', 'litch_demo'],
    })
    const upstream = engine.live.at(-1) as FakeConnection
    upstream.send({
      id: 'demo-1',
      method: 'item/tool/call',
      params: {
        threadId: 'pi-1',
        turnId: 't1',
        callId: 'c1',
        namespace: 'litch_demo',
        tool: 'ping',
        arguments: {},
      },
    })
    await until('设备答了', () => upstream.answers.some((frame) => frame.id === 'demo-1'))
    assert.deepEqual(
      upstream.answers.find((frame) => frame.id === 'demo-1').result,
      ok('demo ping'),
    )
    assert.equal(calls[0]?.harness, 'pi')
    assert.equal(client.requests.filter((frame) => frame.method === 'item/tool/call').length, 0)

    // 内部连接的握手也声明了它
    const link = await target.device.openEngineLink('pi')
    const own = internal(engine)[0]
    assert.ok(own, '内部连接连上了')
    assert.deepEqual(JSON.parse(own.raw[0] as string).params.capabilities.litchClientTools, {
      namespaces: ['litch_tasks', 'litch_sessions', 'litch_demo'],
      anyThread: ['litch_tasks', 'litch_sessions', 'litch_demo'],
    })
    link.close()
  } finally {
    await target.close()
  }
})

test('内部连接：请求、通知、发一个回合等它结束；harness 不在回 harnessUnavailable；引擎断了 onClose 收到、runTurn 抛错', async () => {
  const engine = new TaskEngine()
  engine.script = () => ({ status: 'completed', answer: '做完了' })
  const target = taskRig({ pi: engine })
  try {
    await assert.rejects(
      target.device.openEngineLink('nope'),
      (error) => error instanceof EngineUnavailable && error.data.litch === 'unknownHarness',
    )
    const link = await target.device.openEngineLink('pi')
    assert.equal(link.harness, 'pi')
    assert.equal(link.native, false)
    assert.equal(link.runtime?.engine, 'pi')
    const notes: string[] = []
    const stop = link.onNotification((method) => notes.push(method))
    const { thread } = await link.request('thread/start', { cwd: target.stateDir })
    const done = await runTurn(
      link,
      {
        threadId: thread.id,
        input: [{ type: 'text', text: '做吧' }],
        overrides: { effort: 'low' },
      },
      { timeoutMs: 5000 },
    )
    assert.equal(done.status, 'completed')
    assert.equal(done.lastMessage, '做完了')
    assert.equal(done.error, null)
    assert.equal(engine.turns.at(-1)?.params.effort, 'low')
    assert.ok(notes.includes('turn/completed'))
    stop()

    engine.script = () => ({ status: 'failed' })
    const failed = await runTurn(link, { threadId: thread.id, input: [] }, { timeoutMs: 5000 })
    assert.equal(failed.status, 'failed')

    engine.script = () => ({ status: null })
    let started: string | null = null
    const timed = await runTurn(
      link,
      { threadId: thread.id, input: [] },
      { timeoutMs: 100, interruptGraceMs: 2000, onStarted: (id) => (started = id) },
    )
    assert.equal(timed.status, 'timedOut')
    assert.equal(timed.turnId, started)
    assert.ok(engine.seen.some((item) => item.method === 'turn/interrupt'))

    const reasons: string[] = []
    link.onClose((reason) => reasons.push(reason))
    const hanging = runTurn(link, { threadId: thread.id, input: [] }, { timeoutMs: 60_000 })
    await until('回合开始', () => engine.turns.length === 4)
    engine.crash()
    await assert.rejects(hanging, /lost/)
    assert.equal(reasons.length, 1)
    await assert.rejects(link.request('thread/read', { threadId: thread.id }))
  } finally {
    await target.close()
  }
})

/** 以引擎的身份发一条审批请求 */
function approval(connection: FakeConnection, id: string, threadId: string): void {
  connection.send({
    id,
    method: 'item/commandExecution/requestApproval',
    params: { threadId, turnId: 't1', itemId: 'i1', command: 'ls' },
  })
}

const errorOf = (connection: FakeConnection, id: string) =>
  connection.answers.find((frame) => frame.id === id)?.error

test('内部连接收到审批（Pi 这种没人可送就失败的引擎）：没有客户端拿着就回“没人可送”；客户端拿着就不答，客户端走了再回', async () => {
  const engine = new TaskEngine()
  const target = taskRig({ pi: engine }, { engineLinks: { heldGraceMs: 30, heldRecheckMs: 50 } })
  try {
    const link = await target.device.openEngineLink('pi')
    const own = internal(engine)[0] as FakeConnection
    approval(own, 'req-1', 'pi-1')
    await until('替引擎回了', () => errorOf(own, 'req-1') !== undefined)
    assert.equal(errorOf(own, 'req-1').message, NO_RECIPIENT_MESSAGE)

    // 上游已经说这条请求有结果了：不答
    approval(own, 'req-2', 'pi-1')
    own.send({ method: 'serverRequest/resolved', params: { threadId: 'pi-1', requestId: 'req-2' } })
    await settle(150)
    assert.equal(errorOf(own, 'req-2'), undefined)

    // 同一条请求（请求号相同）也发给了客户端连接对应的上游连接：客户端拿着，内部连接不答
    const client = target.connect()
    await client.initialize(DECLARED)
    const upstream = engine.live.find(
      (connection) => !internal(engine).includes(connection),
    ) as FakeConnection
    approval(upstream, 'req-3', 'pi-1')
    approval(own, 'req-3', 'pi-1')
    await client.waitFor((frame) => frame.id === 'req-3')
    await settle(200)
    assert.equal(errorOf(own, 'req-3'), undefined, '客户端拿着，留给它')
    // 客户端走了，没人拿着了：替引擎回
    client.close()
    await until('客户端走后回了', () => errorOf(own, 'req-3') !== undefined)
    assert.equal(errorOf(own, 'req-3').message, NO_RECIPIENT_MESSAGE)
    link.close()
  } finally {
    await target.close()
  }
})

test('内部连接收到审批：设备进程的另一条连接接过去了（定时任务回合里的审批）也算有人拿着，不替引擎回“没人可送”；那条连接关了再回', async () => {
  const engine = new TaskEngine()
  const target = taskRig({ pi: engine }, { engineLinks: { heldGraceMs: 30, heldRecheckMs: 50 } })
  try {
    // 先开的是定时任务那条，接过这个会话里的审批；后开的是会话树那条（客户端断开后跟着在跑的会话）
    const task = await target.device.openEngineLink('pi')
    task.claimRequests(
      (method, params) => method.endsWith('requestApproval') && params.threadId === 'pi-1',
    )
    const tree = await target.device.openEngineLink('pi')
    const [taskSide, treeSide] = internal(engine) as FakeConnection[]
    if (!taskSide || !treeSide) throw new Error('少了一条内部连接')
    approval(taskSide, 'req-5', 'pi-1')
    approval(treeSide, 'req-5', 'pi-1')
    await until('接过去了', () => task.claimed('req-5'))
    await settle(200)
    assert.equal(errorOf(treeSide, 'req-5'), undefined, '定时任务那条拿着，会话树那条不答')
    // 定时任务那条答了：不再算它拿着
    task.answer('req-5', { decision: 'decline' })
    assert.equal(task.claimed('req-5'), false)
    // 还没答就关了：没人拿着了，照引擎的规矩替它回
    approval(taskSide, 'req-6', 'pi-1')
    approval(treeSide, 'req-6', 'pi-1')
    await until('接过去了', () => task.claimed('req-6'))
    task.close()
    await until('关了以后回了', () => errorOf(treeSide, 'req-6') !== undefined)
    assert.equal(errorOf(treeSide, 'req-6').message, NO_RECIPIENT_MESSAGE)
    tree.close()
  } finally {
    await target.close()
  }
})

test('内部连接收到审批（Claude 这种没人可送时一直等着的引擎）：照引擎原来的做法，不答', async () => {
  const engine = new TaskEngine('claude-code')
  const target = taskRig(
    { 'claude-code': engine },
    { engineLinks: { heldGraceMs: 30, heldRecheckMs: 50 } },
  )
  try {
    const link = await target.device.openEngineLink('claude-code')
    const own = internal(engine)[0] as FakeConnection
    approval(own, 'req-1', 'claude-1')
    await settle(300)
    assert.equal(own.answers.length, 0)
    link.close()
  } finally {
    await target.close()
  }
})
