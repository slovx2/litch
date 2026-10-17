import assert from 'node:assert/strict'
import test from 'node:test'
import { AcpServer } from '../src/server.mjs'
import { client, isolate, text, violations } from './client.mjs'

// 一个会话被几条连接同时订阅（桌面端和手机端都开着）：事件都送到，审批发给每一条、先答的生效，
// 别的连接收到 serverRequest/resolved；先断开的那条不带走还在等的审批。

test('几条连接订阅同一个会话：事件都到，审批先答的生效', async () => {
  const env = await isolate()
  const server = new AcpServer(env.home, env.env)
  try {
    const desktop = client(server)
    const phone = client(server)
    const stranger = client(server)
    for (const peer of [desktop, phone, stranger])
      await peer.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const { thread } = await desktop.call('thread/start', { cwd: env.cwd })
    await phone.call('thread/resume', { threadId: thread.id })
    // 新建会话是广播，谁都收到；回合里的事件只给订阅的
    await stranger.until('thread/started', (p) => p.thread.id === thread.id)

    desktop.onRequest(() => undefined)
    phone.onRequest(() => undefined)
    const { turn } = await desktop.call('turn/start', { threadId: thread.id, input: text('run') })
    const asked = await Promise.all(
      [desktop, phone].map(async (peer) => {
        for (let waited = 0; waited < 5000 && !peer.requests.length; waited += 20)
          await new Promise((resolve) => setTimeout(resolve, 20))
        return peer.requests[0]
      }),
    )
    assert.ok(asked[0] && asked[1], '两条连接都收到审批')
    assert.equal(asked[0].params.itemId, asked[1].params.itemId)
    // 手机先答
    await phone.respond(asked[1], { decision: 'accept' })
    const done = await desktop.until('turn/completed', (p) => p.turn.id === turn.id)
    assert.equal(done.turn.status, 'completed')
    await phone.until('turn/completed', (p) => p.turn.id === turn.id)
    const resolved = await desktop.until('serverRequest/resolved')
    assert.equal(resolved.requestId, asked[0].id)
    // 桌面晚到的回答不再生效，agent 只收到一个回答
    await desktop.respond(asked[0], { decision: 'decline' })
    const answers = (await env.received()).filter((m) => m.result?.outcome)
    assert.equal(answers.length, 1)
    assert.equal(answers[0].result.outcome.optionId, 'once')
    assert.equal(
      stranger.notifications.some((n) => n.method === 'item/agentMessage/delta'),
      false,
      '没订阅的连接收不到回合里的事件',
    )

    // 审批挂着时桌面断开：手机还能答
    const second = await desktop.call('turn/start', { threadId: thread.id, input: text('run') })
    for (let waited = 0; waited < 5000 && phone.requests.length < 2; waited += 20)
      await new Promise((resolve) => setTimeout(resolve, 20))
    server.closePeer(desktop.peer)
    await phone.respond(phone.requests[1], { decision: 'decline' })
    const refused = await phone.until('turn/completed', (p) => p.turn.id === second.turn.id)
    const command = refused.turn.items.find((item: any) => item.type === 'commandExecution')
    assert.equal(command.status, 'declined')
    assert.deepEqual([...violations], [])
  } finally {
    await server.close()
    await env.restore()
  }
})
