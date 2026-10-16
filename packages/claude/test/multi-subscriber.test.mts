import assert from 'node:assert/strict'
import test from 'node:test'
import { deferred } from './fixtures/deferred.mjs'
import { type Connection, openStage, type Stage, sayAndFinish } from './fixtures/in-process.mjs'

// 一个会话多个订阅连接（设计文档 03 第八节 A6）之一：通知与订阅的进出。
// 每条订阅连接都收到这个会话的通知；订阅者断开或退订只摘掉它自己。
// 审批、提问这类请求见 multi-subscriber-requests.test.mts。

const text = (value: string) => [{ type: 'text', text: value }]
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

async function withStage(name: string, run: (stage: Stage) => Promise<void>): Promise<void> {
  const stage = await openStage(name)
  try {
    await run(stage)
  } finally {
    await stage.dispose()
  }
}

// 两条连接订阅同一个会话：first 新建，second 恢复。
async function shared(stage: Stage): Promise<{
  first: Connection
  second: Connection
  threadId: string
}> {
  const first = await stage.connect('first')
  const second = await stage.connect('second')
  const { thread } = await first.request('thread/start', { cwd: stage.directory })
  await second.request('thread/resume', { threadId: thread.id })
  await settle()
  return { first, second, threadId: thread.id }
}

const threadNotifications = (connection: Connection, threadId: string, from = 0) =>
  connection.trace
    .slice(from)
    .filter((message) => message.method && message.id === undefined)
    .filter((message) => message.params?.threadId === threadId)

// 上游发给所有连接的会话级通知（rust-v0.162.0-alpha.20 里经全局的 OutgoingMessageSender 发，清单是
// packages/shared/src/protocol-contract.mts 的 BROADCAST_THREAD_NOTIFICATIONS）。没订阅、没读过一个会话的连接
// （官方桌面端的别的窗口、Litch 侧栏上别处在跑的会话）靠它们跟着变；回合、条目这些只给订阅者。
const EVERYONE = new Set([
  'thread/started',
  'thread/status/changed',
  'thread/name/updated',
  'thread/archived',
  'thread/unarchived',
  'thread/closed',
  'thread/deleted',
  'thread/reverted',
  'thread/project/updated',
  'thread/attachment/updated',
  'thread/goal/updated',
  'thread/goal/cleared',
])

// 一条连接收到的、关于某个会话的通知（thread/started 的会话号在 thread 里）。
const about = (connection: Connection, threadId: string, from = 0) =>
  connection.trace
    .slice(from)
    .filter((message) => message.method && message.id === undefined)
    .filter(
      (message) => message.params?.threadId === threadId || message.params?.thread?.id === threadId,
    )

test('MULTI-001：两条连接订阅同一个会话，同一个回合的通知两边都收到，逐条相同', async () => {
  await withStage('multi-notify', async (stage) => {
    const first = await stage.connect('first')
    const second = await stage.connect('second')
    const { thread } = await first.request('thread/start', { cwd: stage.directory })
    await settle()
    const quiet = first.trace.length
    await second.request('thread/resume', { threadId: thread.id })
    await settle()
    assert.equal(
      first.trace.length,
      quiet,
      '别的连接只是打开这个会话，先来的连接线上不多出任何东西',
    )

    const mark = { first: first.trace.length, second: second.trace.length }
    stage.script = async (_context, handlers) => {
      await handlers.onEvent({ type: 'reasoning_delta', delta: '想一想' })
      await handlers.onEvent({ type: 'text_delta', delta: '你' })
      await handlers.onEvent({ type: 'text_delta', delta: '好' })
      await handlers.onEvent({ type: 'usage', usage: { input_tokens: 10, output_tokens: 2 } })
      await handlers.onEvent({ type: 'completed', success: true, result: '你好' })
    }
    const { turn } = await first.request('turn/start', { threadId: thread.id, input: text('问好') })
    assert.equal((await first.completed(turn.id)).status, 'completed')
    assert.equal((await second.completed(turn.id)).status, 'completed')
    await settle()

    const seen = threadNotifications(first, thread.id, mark.first)
    assert.deepEqual(threadNotifications(second, thread.id, mark.second), seen)
    const methods = new Set(seen.map((message) => message.method))
    for (const method of [
      'thread/status/changed',
      'turn/started',
      'item/started',
      'item/agentMessage/delta',
      'item/completed',
      'thread/tokenUsage/updated',
      'turn/completed',
    ])
      assert.ok(methods.has(method), `两边都应收到 ${method}：${[...methods].join(', ')}`)
  })
})

test('MULTI-002：一条订阅连接中途断开，另一条不受影响（先订阅的断开、后订阅的断开都一样）', async () => {
  for (const leaving of ['first', 'second'] as const)
    await withStage(`multi-drop-${leaving}`, async (stage) => {
      const peers = await shared(stage)
      const staying = peers[leaving === 'first' ? 'second' : 'first']
      const gate = deferred()
      stage.script = async (_context, handlers) => {
        await handlers.onEvent({ type: 'text_delta', delta: '前半' })
        await gate.promise
        await handlers.onEvent({ type: 'text_delta', delta: '后半' })
        await handlers.onEvent({ type: 'completed', success: true, result: '前半后半' })
      }
      const { turn } = await peers.first.request('turn/start', {
        threadId: peers.threadId,
        input: text('说两段'),
      })
      for (const peer of [peers.first, peers.second])
        await peer.notification('item/agentMessage/delta', (params) => params.delta === '前半')
      peers[leaving].disconnect()
      const silent = peers[leaving].trace.length
      gate.resolve()
      assert.equal((await staying.completed(turn.id)).status, 'completed')
      assert.deepEqual(
        staying.notifications('item/agentMessage/delta').map((message) => message.params.delta),
        ['前半', '后半'],
        '留下的连接收到整个回合',
      )
      assert.equal(peers[leaving].trace.length, silent, '断开的连接不再收到任何东西')

      // 留下的连接接着用这个会话。
      stage.script = sayAndFinish('第二轮')
      const next = await staying.request('turn/start', {
        threadId: peers.threadId,
        input: text('再来'),
      })
      assert.equal((await staying.completed(next.turn.id)).status, 'completed')
    })
})

test('MULTI-003：一条连接退订之后收不到回合和条目（会话级的照收），另一条照常；最后一个订阅者退订，会话才算关闭', async () => {
  await withStage('multi-unsubscribe', async (stage) => {
    const { first, second, threadId } = await shared(stage)
    assert.deepEqual(await first.request('thread/unsubscribe', { threadId }), {
      status: 'unsubscribed',
    })
    await settle()
    assert.deepEqual(first.notifications('thread/closed'), [], '还有连接在看，会话没有关闭')
    assert.deepEqual((await second.request('thread/loaded/list', {})).data, [threadId])

    const silent = first.trace.length
    stage.script = sayAndFinish('只有一边在看')
    const { turn } = await second.request('turn/start', { threadId, input: text('继续') })
    assert.equal((await second.completed(turn.id)).status, 'completed')
    await settle()
    assert.deepEqual(
      first.trace.slice(silent).map((message) => message.method),
      ['thread/status/changed', 'thread/status/changed'],
      '退订的连接收不到回合和条目；状态变化和上游一样发给所有连接，照收',
    )
    assert.deepEqual(await first.request('thread/unsubscribe', { threadId }), {
      status: 'notSubscribed',
    })

    assert.deepEqual(await second.request('thread/unsubscribe', { threadId }), {
      status: 'unsubscribed',
    })
    assert.deepEqual(
      second.notifications('thread/closed').map((message) => message.params),
      [{ threadId }],
      '最后一个订阅者退订时收到 thread/closed，和只有一条连接时一样',
    )
    assert.deepEqual(
      first.notifications('thread/closed').map((message) => message.params),
      [{ threadId }],
      '关闭和上游一样发给所有连接，早先退订的那条也收到',
    )
    assert.deepEqual((await second.request('thread/loaded/list', {})).data, [])
  })
})

test('MULTI-004：删除会话，每条连接都被告知（订阅着的、没订阅的都一样）', async () => {
  await withStage('multi-delete', async (stage) => {
    const { first, second, threadId } = await shared(stage)
    const outsider = await stage.connect('outsider')
    await outsider.request('thread/delete', { threadId })
    for (const subscriber of [first, second]) {
      assert.deepEqual(
        subscriber.notifications('thread/closed').map((message) => message.params),
        [{ threadId }],
      )
      assert.equal(subscriber.notifications('thread/deleted').length, 1)
    }
    assert.equal(outsider.notifications('thread/deleted').length, 1)
    assert.equal(outsider.notifications('thread/closed').length, 1)
  })
})

test('MULTI-005：会话设置的变化、改名，订阅着的每条连接都收到', async () => {
  await withStage('multi-settings', async (stage) => {
    const { first, second, threadId } = await shared(stage)
    const mark = { first: first.trace.length, second: second.trace.length }
    await second.request('thread/settings/update', { threadId, effort: 'high' })
    await first.request('thread/name/set', { threadId, name: '两边都看得到' })
    await settle()
    const seen = threadNotifications(first, threadId, mark.first)
    assert.deepEqual(
      seen.map((message) => message.method),
      ['thread/settings/updated', 'thread/name/updated'],
    )
    assert.equal(seen[0].params.threadSettings.effort, 'high')
    assert.deepEqual(threadNotifications(second, threadId, mark.second), seen)
  })
})

test('MULTI-006：CLI 自行续跑的回合：有连接订阅时每条都收到；退订了的连接、无人订阅时只有状态变化通知到连接', async () => {
  await withStage('multi-spontaneous', async (stage) => {
    const { first, second, threadId } = await shared(stage)
    stage.script = sayAndFinish('后台命令跑完了')
    const mark = { first: first.trace.length, second: second.trace.length }
    assert.equal(await stage.session().onSpontaneousTurn(threadId), true)
    const started = await first.notification('turn/started')
    await first.completed(started.params.turn.id)
    await second.completed(started.params.turn.id)
    await settle()
    assert.deepEqual(
      threadNotifications(second, threadId, mark.second),
      threadNotifications(first, threadId, mark.first),
    )

    // 先退订一条，再两条都退订。回合内容只给还订阅着的，状态变化总是发给所有连接。
    await first.request('thread/unsubscribe', { threadId })
    const one = { first: first.trace.length, second: second.trace.length }
    assert.equal(await stage.session().onSpontaneousTurn(threadId), true)
    await second.until('第二个自行续跑的回合落库', () =>
      stage.store.listTurns(threadId).length === 2 &&
      stage.store.listTurns(threadId)[1]?.status === 'completed'
        ? true
        : undefined,
    )
    await settle()
    assert.deepEqual(
      threadNotifications(first, threadId, one.first).map((message) => message.method),
      ['thread/status/changed', 'thread/status/changed'],
      '退订的那条只收到状态变化（和上游一样发给所有连接）',
    )
    assert.ok(
      threadNotifications(second, threadId, one.second).some((m) => m.method === 'turn/completed'),
      '还订阅着的那条照常收到',
    )

    await second.request('thread/unsubscribe', { threadId })
    await settle()
    const none = { first: first.trace.length, second: second.trace.length }
    assert.equal(await stage.session().onSpontaneousTurn(threadId), true)
    await second.until('第三个自行续跑的回合落库', () =>
      stage.store.listTurns(threadId)[2]?.status === 'completed' ? true : undefined,
    )
    await settle()
    for (const [connection, from] of [
      [first, none.first],
      [second, none.second],
    ] as const)
      assert.deepEqual(
        threadNotifications(connection, threadId, from).map((message) => message.method),
        ['thread/status/changed', 'thread/status/changed'],
        `${connection.name}：无人订阅时只有状态变化（开始、结束）通知到连接`,
      )
  })
})

test('MULTI-007：没订阅、没读过的连接照样收到会话的新建、状态、改名、归档、删除，收不到回合和条目；临时会话的不给它', async () => {
  await withStage('multi-broadcast', async (stage) => {
    const owner = await stage.connect('owner')
    const bystander = await stage.connect('bystander')
    const reader = await stage.connect('reader')
    const mark = { bystander: bystander.trace.length, reader: reader.trace.length }
    const { thread } = await owner.request('thread/start', { cwd: stage.directory })
    const threadId: string = thread.id
    await reader.request('thread/read', { threadId, includeTurns: false })
    stage.script = sayAndFinish('别处在跑')
    const { turn } = await owner.request('turn/start', { threadId, input: text('跑一下') })
    assert.equal((await owner.completed(turn.id)).status, 'completed')
    await owner.request('thread/name/set', { threadId, name: '别处改的名字' })
    await owner.request('thread/archive', { threadId })
    await owner.request('thread/unarchive', { threadId })
    // 客户端起标题用的临时会话：它的新建、状态、改名都只给建它的连接
    const helper: string = (
      await owner.request('thread/start', { cwd: stage.directory, ephemeral: true })
    ).thread.id
    stage.script = sayAndFinish('标题')
    const titled = await owner.request('turn/start', { threadId: helper, input: text('起个标题') })
    assert.equal((await owner.completed(titled.turn.id)).status, 'completed')
    await owner.request('thread/name/set', { threadId: helper, name: '标题' })
    await owner.request('thread/delete', { threadId })
    await owner.request('thread/delete', { threadId: helper })
    await settle()

    assert.ok(
      owner.notifications('item/agentMessage/delta').length > 0,
      '订阅着的连接照常收到回合的内容',
    )
    for (const [connection, from] of [
      [bystander, mark.bystander],
      [reader, mark.reader],
    ] as const) {
      const seen = about(connection, threadId, from)
      const methods = seen.map((message) => message.method)
      for (const method of methods)
        assert.ok(EVERYONE.has(method), `${connection.name} 不该收到 ${method}`)
      assert.equal(methods.filter((method) => method === 'thread/started').length, 1)
      const statuses = seen
        .filter((message) => message.method === 'thread/status/changed')
        .map((message) => message.params.status.type)
      assert.ok(
        statuses.includes('active') && statuses.at(-1) === 'idle',
        `${connection.name} 的状态：${statuses}`,
      )
      assert.deepEqual(
        seen
          .filter((message) => message.method === 'thread/name/updated')
          .map((message) => message.params.threadName),
        ['别处改的名字'],
      )
      for (const method of ['thread/archived', 'thread/unarchived', 'thread/deleted'])
        assert.equal(methods.filter((item) => item === method).length, 1, method)
      assert.deepEqual(
        about(connection, helper, from),
        [],
        `${connection.name} 收不到临时会话的通知`,
      )
    }
    assert.ok(
      owner.notifications('thread/started').some((message) => message.params.thread.id === helper),
      '建临时会话的连接照旧收到它的新建',
    )
    assert.deepEqual(
      about(owner, helper)
        .filter(
          (message) => message.method === 'thread/closed' || message.method === 'thread/deleted',
        )
        .map((message) => message.method),
      ['thread/closed', 'thread/deleted'],
      '删它的连接照旧收到临时会话的关闭和删除',
    )
  })
})

test('MULTI-008：目标、归属、附件的变化和会话关闭，没订阅的连接也收到；临时会话关闭只告诉退订它的连接', async () => {
  await withStage('multi-broadcast-more', async (stage) => {
    const owner = await stage.connect('owner')
    const bystander = await stage.connect('bystander')
    const { thread } = await owner.request('thread/start', { cwd: stage.directory })
    const threadId: string = thread.id
    const helper: string = (
      await owner.request('thread/start', { cwd: stage.directory, ephemeral: true })
    ).thread.id
    await settle()
    const mark = bystander.trace.length
    await owner.request('thread/goal/set', {
      threadId,
      objective: '别处定的目标',
      status: 'paused',
    })
    await settle()
    await owner.request('thread/goal/clear', { threadId })
    const { project } = await owner.request('project/create', {
      name: '别处建的项目',
      roots: [{ path: stage.directory }],
      idempotencyKey: 'broadcast',
    })
    await owner.request('thread/metadata/update', { threadId, projectId: project.id })
    await owner.request('thread/attachment/add', {
      threadId,
      attachmentType: 'source',
      identityKey: 'broadcast',
      payload: { source: '别处加的附件' },
    })
    await settle()
    // 最后一个订阅者退订，会话关闭
    await owner.request('thread/unsubscribe', { threadId })
    await owner.request('thread/unsubscribe', { threadId: helper })
    await settle()

    assert.deepEqual(
      about(bystander, threadId, mark)
        .map((message) => message.method)
        .sort(),
      [
        'thread/attachment/updated',
        'thread/closed',
        'thread/goal/cleared',
        'thread/goal/updated',
        'thread/project/updated',
      ],
    )
    assert.deepEqual(about(bystander, helper), [], '收不到临时会话的通知')
    assert.ok(
      owner.notifications('thread/closed').some((message) => message.params.threadId === helper),
      '退订临时会话的连接照旧收到它关闭',
    )
  })
})
