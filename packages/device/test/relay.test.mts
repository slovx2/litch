import assert from 'node:assert/strict'
import test from 'node:test'
import { FakeUpstream } from './fake-upstream.mjs'
import { assertStatusChanged, assertThreadList, errorCode, rig, settle } from './helpers.mjs'

const STATUS = 'litch/harness/status/changed'

test('通知：带会话标识的原样转发，不带的加上 harness，会话开始的通知打标并进索引', async () => {
  const pi = new FakeUpstream('pi')
  const claude = new FakeUpstream('claude-code')
  // 握手一完成上游就主动推通知（Claude 引擎会推账号状态）：必须排在握手应答后面
  claude.handlers.initialize = (_params, connection) => {
    connection.send({ method: 'account/updated', params: { authMode: 'apikey', planType: null } })
    return { userAgent: 'fake/0.163.0', codexHome: '/', platformFamily: 'unix', platformOs: 'test' }
  }
  const env = rig({ pi, 'claude-code': claude })
  try {
    const client = env.connect()
    await client.initialize()
    assert.equal(typeof JSON.parse(client.raw[0] ?? '{}').result?.userAgent, 'string')
    assert.deepEqual(client.notifications[0], {
      method: 'account/updated',
      params: { authMode: 'apikey', planType: null, harness: 'claude-code' },
    })

    // 带会话标识的：客户端收到的原文和上游发的一模一样，没有重新序列化
    const delta =
      '{"method":"item/agentMessage/delta","params":{"threadId":"t1","turnId":"u1","itemId":"i1","delta":"字"},"extra":  1}'
    pi.live[0]?.send(null, delta)
    await client.waitFor((frame) => frame.method === 'item/agentMessage/delta')
    assert.equal(client.raw.at(-1), delta)

    // 不带会话标识的：加上是哪个 harness 发的；没有参数的也加
    pi.notify('skills/changed')
    pi.notify('mcpServer/startupStatus/updated', { name: 'fs', status: 'ready' })
    await client.waitFor((frame) => frame.method === 'mcpServer/startupStatus/updated')
    assert.deepEqual(client.notifications.slice(-2), [
      { method: 'skills/changed', params: { harness: 'pi' } },
      {
        method: 'mcpServer/startupStatus/updated',
        params: { name: 'fs', status: 'ready', harness: 'pi' },
      },
    ])

    // 会话开始：会话对象打上 harness，最终标识进索引；之前用临时标识发的通知不会让临时标识进索引
    pi.threads.push({ id: 'final-id', updatedAt: 1 })
    pi.notify('thread/status/changed', { threadId: 'temp-id', status: { type: 'idle' } })
    pi.notify('thread/started', {
      threadId: 'final-id',
      thread: { id: 'final-id', ephemeral: false },
    })
    const started = await client.waitFor((frame) => frame.method === 'thread/started')
    // 工作区、分区是设备层的值（这个会话在设备层没有归属）
    const unassigned = { projectId: null, section: null, sectionEnteredAt: null }
    assert.deepEqual(started.params, {
      threadId: 'final-id',
      thread: { id: 'final-id', ephemeral: false, harness: 'pi', ...unassigned },
    })
    await client.call('turn/start', { threadId: 'final-id', input: [] })
    assert.ok(!pi.seen.some((entry) => entry.method === 'thread/read'))
    // 临时标识没有被登记：拿它发请求要向上游打听，而上游不认识
    assert.equal(
      (await client.fails('turn/start', { threadId: 'temp-id', input: [] })).data.litch,
      'unknownThread',
    )
    // 原生 codex 的 thread/started 不带 threadId：两处都打上
    claude.notify('thread/started', { thread: { id: 'cc-new' } })
    const native = await client.waitFor(
      (frame) => frame.method === 'thread/started' && (frame.params as any).thread.id === 'cc-new',
    )
    assert.deepEqual(native.params, {
      thread: { id: 'cc-new', harness: 'claude-code', ...unassigned },
      harness: 'claude-code',
    })
  } finally {
    await env.close()
  }
})

test('退订名单在路由层生效：被退订的通知不转发，记账照做', async () => {
  const pi = new FakeUpstream('pi')
  const env = rig({ pi })
  try {
    const client = env.connect()
    await client.initialize(['harness'], {
      optOutNotificationMethods: ['thread/started', 'skills/changed', 'item/agentMessage/delta'],
    })
    pi.threads.push({ id: 'quiet', updatedAt: 1 })
    pi.notify('thread/started', { threadId: 'quiet', thread: { id: 'quiet' } })
    pi.notify('skills/changed', {})
    pi.notify('item/agentMessage/delta', { threadId: 'quiet', delta: 'x' })
    pi.notify('turn/completed', { threadId: 'quiet', turn: { id: 'u' } })
    await client.waitFor((frame) => frame.method === 'turn/completed')
    assert.deepEqual(
      client.notifications.map((frame) => frame.method),
      ['turn/completed'],
    )
    // 通知没转发，但会话归属照样记下了
    await client.call('turn/start', { threadId: 'quiet', input: [] })
    assert.ok(!pi.seen.some((entry) => entry.method === 'thread/read'))
  } finally {
    await env.close()
  }
})

test('服务端发起的请求：原样转给客户端，应答原路送回；请求号撞了也送得对', async () => {
  const pi = new FakeUpstream('pi')
  const codex = new FakeUpstream(null)
  const env = rig({ pi, codex })
  try {
    const client = env.connect()
    await client.initialize()
    const approval =
      '{"id":"req-pi","method":"item/commandExecution/requestApproval","params":{"threadId":"t1","command":"ls"}}'
    pi.live[0]?.send(null, approval)
    await client.waitFor((frame) => frame.id === 'req-pi')
    assert.equal(client.raw.at(-1), approval)
    const reply = '{"id":"req-pi","result":{"decision":"accept"}}'
    client.sendRaw(reply)
    await settle()
    assert.equal(pi.live[0]?.raw.at(-1), reply)
    assert.equal(codex.live[0]?.answers.length, 0)

    // 两个上游用了同一个请求号（原生 codex 的请求号是递增的整数）
    codex.live[0]?.send({
      id: 7,
      method: 'item/tool/requestUserInput',
      params: { threadId: 'x', questions: [] },
    })
    pi.live[0]?.send({
      id: 7,
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'y' },
    })
    await client.waitFor((frame) => frame.method === 'item/fileChange/requestApproval')
    const [first, second] = client.requests.slice(-2)
    assert.equal(first?.id, 7)
    assert.notEqual(second?.id, 7)
    // 先答后来的那个，各自回到各自的上游，上游看到的是它自己的请求号
    client.answer(second?.id, { decision: 'decline' })
    client.answer(7, { answers: {} })
    await settle()
    assert.deepEqual(pi.live[0]?.answers.at(-1), { id: 7, result: { decision: 'decline' } })
    assert.deepEqual(codex.live[0]?.answers.at(-1), { id: 7, result: { answers: {} } })

    // 换过请求号的，上游说“已经有结果了”时客户端看到的也是换过的那个
    codex.live[0]?.send({ id: 8, method: 'item/tool/requestUserInput', params: { threadId: 'x' } })
    pi.live[0]?.send({
      id: 8,
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'y' },
    })
    const renamed = await client.waitFor(
      (frame) =>
        frame.method === 'item/fileChange/requestApproval' &&
        frame.id !== 7 &&
        frame.id !== second?.id,
    )
    pi.notify('serverRequest/resolved', { threadId: 'y', requestId: 8 })
    const resolved = await client.waitFor((frame) => frame.method === 'serverRequest/resolved')
    assert.deepEqual(resolved.params, { threadId: 'y', requestId: renamed.id })
    // 已经有结果的请求，客户端再答也不会送到上游
    const answered = pi.live[0]?.answers.length
    client.answer(renamed.id, { decision: 'accept' })
    await settle()
    assert.equal(pi.live[0]?.answers.length, answered)
  } finally {
    await env.close()
  }
})

test('上游断开：等着的请求回错误、待答的请求作废、发状态变化，别的 harness 不受影响；重连后恢复', async () => {
  const pi = new FakeUpstream('pi', [{ id: 'p1', updatedAt: 5 }])
  const claude = new FakeUpstream('claude-code', [{ id: 'c1', updatedAt: 9 }])
  // 这个请求上游一直不答
  pi.handlers['turn/start'] = () => undefined
  const env = rig({ pi, 'claude-code': claude })
  try {
    const client = env.connect()
    await client.initialize(['harness'], { subAgentActivityKinds: ['completed'] })
    await client.call('thread/list', {})
    const hanging = client.fails('turn/start', { threadId: 'p1', input: [] })
    pi.live[0]?.send({
      id: 'ask-1',
      method: 'item/tool/requestUserInput',
      params: { threadId: 'p1' },
    })
    await client.waitFor((frame) => frame.id === 'ask-1')

    pi.crash()
    const failure = await hanging
    assert.equal(failure.code, errorCode('harnessUnavailable'))
    assert.equal(failure.code, -32050)
    assert.deepEqual(failure.data, {
      litch: 'harnessUnavailable',
      harness: 'pi',
      method: 'turn/start',
    })
    // 上游不在了，替它告诉客户端那个待答的请求已经作废
    const voided = await client.waitFor((frame) => frame.method === 'serverRequest/resolved')
    assert.deepEqual(voided.params, { threadId: 'p1', requestId: 'ask-1' })
    const down = await client.waitFor((frame) => frame.method === STATUS)
    assertStatusChanged(down.params)
    const downInfo = (down.params as any).info
    assert.equal((down.params as any).harness, 'pi')
    assert.equal(downInfo.available, false)
    assert.equal(downInfo.unavailable.kind, 'disconnected')
    // 断开之后名字和版本还是之前握手得到的
    assert.deepEqual([downInfo.displayName, downInfo.version], ['Pi', '1.2.3'])

    // 另一个 harness 照常
    assert.equal(
      (await client.call('turn/start', { threadId: 'c1', input: [] })).turn.id,
      'turn-of-c1',
    )
    // 发给断开的那个：立刻报不可用，不悬着
    const refused = await client.fails('thread/resume', { threadId: 'p1' })
    assert.equal(refused.data.litch, 'harnessUnavailable')
    assert.equal(
      (await client.fails('model/list', { harness: 'pi' })).data.litch,
      'harnessUnavailable',
    )
    // 列表里没有它，并且说明了没包含谁
    const partial = await client.call('thread/list', {})
    assertThreadList(partial)
    assert.deepEqual(
      partial.data.map((thread: any) => thread.id),
      ['c1'],
    )
    assert.deepEqual(
      partial.skippedHarnesses.map((item: any) => [item.harness, item.reason]),
      [['pi', 'unavailable']],
    )
    // 为什么不可用：断了正在重连，或者已经重连过一次没连上，都是 runtime/info 用的那套词
    assert.ok(['disconnected', 'unreachable'].includes(partial.skippedHarnesses[0].kind))
    const info = await client.call('runtime/info')
    assert.deepEqual(
      info.harnesses.map((harness: any) => harness.available),
      [false, true],
    )
    // 一直连不上的时候不反复通知：只在说法变了的时候发（断开 → 连不上）
    await settle(120)
    const kinds = client.notifications
      .filter((frame) => frame.method === STATUS)
      .map((frame) => (frame.params as any).info.unavailable?.kind)
    assert.deepEqual(kinds, ['disconnected', 'unreachable'])

    // 运行时回来了：自己重连，重新握手（带着客户端原来声明的能力），通知恢复可用
    pi.down = false
    const up = await client.waitFor(
      (frame) => frame.method === STATUS && (frame.params as any).info.available === true,
    )
    assertStatusChanged(up.params)
    assert.equal((up.params as any).info.unavailable, null)
    const handshakes = pi.seen.filter((entry) => entry.method === 'initialize')
    assert.equal(handshakes.length, 2)
    assert.deepEqual(handshakes[1]?.params, handshakes[0]?.params)
    assert.deepEqual(handshakes[1]?.params.capabilities.subAgentActivityKinds, ['completed'])
    pi.handlers['turn/start'] = (params) => ({ turn: { id: `again-${params.threadId}` } })
    assert.equal(
      (await client.call('turn/start', { threadId: 'p1', input: [] })).turn.id,
      'again-p1',
    )
  } finally {
    await env.close()
  }
})

test('上游一开始就连不上：设备照常提供服务，等它起来了再通知', async () => {
  const pi = new FakeUpstream('pi', [{ id: 'p1', updatedAt: 5 }])
  const slow = new FakeUpstream('dsh')
  // 握手一直不答：到点就不等了，先报成不可用
  slow.handlers.initialize = () => undefined
  const late = new FakeUpstream('claude-code', [{ id: 'c1', updatedAt: 9 }])
  late.down = true
  const env = rig({ pi, dsh: slow, 'claude-code': late }, { settleMs: 60, handshakeTimeoutMs: 150 })
  try {
    const client = env.connect()
    await client.initialize()
    const info = await client.call('runtime/info')
    assert.deepEqual(
      info.harnesses.map((harness: any) => [harness.id, harness.unavailable?.kind ?? 'ok']),
      [
        ['pi', 'ok'],
        ['dsh', 'connecting'],
        ['claude-code', 'unreachable'],
      ],
    )
    assert.deepEqual(
      (await client.call('thread/list', {})).data.map((thread: any) => thread.id),
      ['p1'],
    )
    // 握手超时的那个：状态从“正在连”变成“握手没成”
    const failed = await client.waitFor(
      (frame) => frame.method === STATUS && (frame.params as any).harness === 'dsh',
    )
    assert.equal((failed.params as any).info.unavailable.kind, 'handshakeFailed')
    // 后起来的那个
    late.down = false
    const up = await client.waitFor(
      (frame) => frame.method === STATUS && (frame.params as any).harness === 'claude-code',
    )
    assert.equal((up.params as any).info.available, true)
    assert.equal((up.params as any).info.displayName, 'Claude Code')
    assert.deepEqual(
      (await client.call('thread/list', { harness: 'claude-code' })).data.map(
        (thread: any) => thread.id,
      ),
      ['c1'],
    )
  } finally {
    await env.close()
  }
})

test('thread/list 的 excludedThreadIds 由设备层合并后统一筛：不转给上游，先排除再凑满一页，超过 100 个拒绝', async () => {
  const pi = new FakeUpstream('pi', [
    { id: 'p1', updatedAt: 9 },
    { id: 'p2', updatedAt: 7 },
    { id: 'p3', updatedAt: 5 },
  ])
  const claude = new FakeUpstream('claude-code', [
    { id: 'c1', updatedAt: 8 },
    { id: 'c2', updatedAt: 6 },
  ])
  const env = rig({ pi, 'claude-code': claude })
  try {
    const client = env.connect()
    await client.initialize()
    const ids = (page: any) => page.data.map((thread: any) => thread.id)
    const first = await client.call('thread/list', { limit: 2, excludedThreadIds: ['p1', 'c1'] })
    assert.deepEqual(ids(first), ['p2', 'c2'])
    const second = await client.call('thread/list', {
      limit: 2,
      excludedThreadIds: ['p1', 'c1'],
      cursor: first.nextCursor,
    })
    assert.deepEqual(ids(second), ['p3'])
    assert.equal(second.nextCursor, null)
    for (const upstream of [pi, claude])
      for (const frame of upstream.seen.filter((frame) => frame.method === 'thread/list'))
        assert.equal('excludedThreadIds' in frame.params, false, '不转给上游')
    const many = Array.from({ length: 101 }, (_, index) => `t-${index}`)
    assert.equal((await client.fails('thread/list', { excludedThreadIds: many })).code, -32602)
    assert.equal((await client.fails('thread/list', { excludedThreadIds: [''] })).code, -32602)
  } finally {
    await env.close()
  }
})
