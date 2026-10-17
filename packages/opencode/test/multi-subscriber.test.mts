import assert from 'node:assert/strict'
import test from 'node:test'
import { client, isolate, skip, text, violations } from './client.mjs'
import { scripted } from './mock-model.mjs'

// 几条连接看同一个会话（桌面和手机同时开着）：通知都收到；审批发给所有订阅了的连接，谁先答算谁的，
// 答完各连接都收到 serverRequest/resolved；审批挂着时才连上、恢复会话的连接也补收到这条请求。
// 会话的新建、改名这类通知发给所有连接，不管订没订阅。
test('OpenCode：多条连接订阅同一会话，审批先答先得、晚连上的补收挂着的请求', {
  skip,
  timeout: 120000,
}, async () => {
  const env = await isolate(
    scripted({
      RUN: [
        [
          {
            type: 'tool',
            name: 'bash',
            input: { command: 'printf shared', description: '要审批' },
          },
        ],
        [{ type: 'text', chunks: ['跑完了。'] }],
      ],
    }),
    { permission: { bash: 'ask' } },
  )
  try {
    const desktop = client(env.server)
    const phone = client(env.server)
    const late = client(env.server)
    for (const peer of [desktop, phone, late]) {
      await peer.initialize()
      peer.onRequest(() => undefined)
    }
    const { thread } = await desktop.call('thread/start', { cwd: env.cwd })
    await phone.call('thread/resume', { threadId: thread.id })
    for (const peer of [desktop, phone, late])
      await peer.until('thread/started', (p) => p.thread.id === thread.id)

    const { turn } = await desktop.call('turn/start', {
      threadId: thread.id,
      input: text('RUN 跑'),
    })
    const onDesktop = await desktop.request('item/commandExecution/requestApproval')
    const onPhone = await phone.request('item/commandExecution/requestApproval')
    assert.equal(onDesktop.params.itemId, onPhone.params.itemId)
    assert.equal(late.requests.length, 0, '没订阅的连接收不到审批')

    // 审批挂着时恢复会话：补收到同一条请求
    const resumed = await late.call('thread/resume', { threadId: thread.id })
    assert.equal(resumed.thread.status.type, 'active')
    assert.deepEqual(resumed.thread.status.activeFlags, ['waitingOnApproval'])
    const onLate = await late.request('item/commandExecution/requestApproval')
    assert.equal(onLate.params.itemId, onDesktop.params.itemId)

    // 手机先答；桌面后答的不算数
    await phone.respond(onPhone, { decision: 'accept' })
    await desktop.respond(onDesktop, { decision: 'decline' })
    for (const peer of [desktop, phone, late]) {
      const done = (await peer.until('turn/completed', (p) => p.turn.id === turn.id)).turn
      assert.equal(done.status, 'completed')
      const command = done.items.find((item: any) => item.type === 'commandExecution')
      assert.equal(command.status, 'completed')
      assert.equal(command.aggregatedOutput, 'shared')
      assert.equal(peer.of('serverRequest/resolved', thread.id).length, 1)
    }
    // 回合中途才订阅的连接也收到后面的流
    assert.ok(late.of('item/completed', thread.id).length > 0)

    // 改名的通知发给所有连接
    const other = client(env.server)
    await other.initialize()
    await desktop.call('thread/name/set', { threadId: thread.id, name: '共享的会话' })
    for (const peer of [desktop, phone, late, other])
      await peer.until(
        'thread/name/updated',
        (p) => p.threadId === thread.id && p.threadName === '共享的会话',
      )
  } finally {
    await env.restore()
  }
  assert.deepEqual([...violations], [])
})
