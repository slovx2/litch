import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { PiServer } from '../src/server.mjs'

// 一个会话多个订阅连接：通知每条订阅连接都收到；提问发给全部订阅连接，
// 请求号相同，先答的生效，其余连接收到 serverRequest/resolved，迟到的应答被丢弃。
// 这里直接对着服务对象测分发；真实 SDK 上两条连接的整轮过程在 adapter.test.mts 里。

interface Recorder extends RpcPeer {
  messages: any[]
  requests(): any[]
  resolved(): any[]
}

function recorder(id: string): Recorder {
  const messages: any[] = []
  return {
    id,
    messages,
    close() {},
    send(message) {
      messages.push(message)
    },
    requests: () => messages.filter((m) => m.method && m.id !== undefined),
    resolved: () => messages.filter((m) => m.method === 'serverRequest/resolved'),
  }
}

async function scene(run: (server: PiServer) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-multi-'))
  const server = new PiServer(root)
  try {
    await run(server)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}

function attach(server: PiServer, threadId: string, ...peers: RpcPeer[]): void {
  for (const peer of peers) {
    server.peers.set(peer.id, peer)
    server.subscribe(peer, threadId)
  }
}

const question = { isBlocking: true, questions: [] }
const answer = (id: unknown, label: string) =>
  ({ jsonrpc: '2.0', id, result: { answers: { q: { answers: [label] } } } }) as any

test('MULTI-PI-001：提问发给全部订阅连接，先答的生效，其余收到已解决，迟到的应答丢弃', async () => {
  await scene(async (server) => {
    const first = recorder('first')
    const second = recorder('second')
    attach(server, 't', first, second)
    const asked = server.call(first, 't', 'item/tool/requestUserInput', question)
    assert.equal(first.requests().length, 1)
    assert.deepEqual(second.requests(), first.requests(), '两条连接收到同一条请求，请求号相同')
    const request = first.requests()[0]

    await server.handle(second, answer(request.id, '后订阅的先答'))
    assert.deepEqual(await asked, { answers: { q: { answers: ['后订阅的先答'] } } })
    for (const peer of [first, second])
      assert.deepEqual(
        peer.resolved().map((m) => m.params),
        [{ threadId: 't', requestId: request.id }],
        `${peer.id} 收到一次已解决`,
      )

    // 另一条连接这时才答：请求已经没了，什么都不发生。
    const before = [first.messages.length, second.messages.length]
    await server.handle(first, answer(request.id, '迟到的'))
    assert.deepEqual([first.messages.length, second.messages.length], before)
  })
})

test('MULTI-PI-002：拿着请求的连接断开一条，请求留给还在的那条；反过来也一样', async () => {
  for (const leaving of ['first', 'second'] as const)
    await scene(async (server) => {
      const peers = { first: recorder('first'), second: recorder('second') }
      attach(server, 't', peers.first, peers.second)
      const staying = peers[leaving === 'first' ? 'second' : 'first']
      const asked = server.call(peers.first, 't', 'item/tool/requestUserInput', question)
      const request = staying.requests()[0]
      server.closePeer(peers[leaving])
      assert.equal(staying.resolved().length, 0, '还有连接拿着请求，不能当作已经有结果')
      await server.handle(staying, answer(request.id, '留下的来答'))
      assert.deepEqual(await asked, { answers: { q: { answers: ['留下的来答'] } } })
      assert.equal(staying.resolved().length, 1)
      // 断开之后的通知只到还在的那条。
      const mark = peers[leaving].messages.length
      server.notify('t', 'thread/name/updated', { threadName: '改名' })
      assert.equal(peers[leaving].messages.length, mark)
      assert.equal(staying.messages.at(-1).method, 'thread/name/updated')
    })
})

test('MULTI-PI-003：拿着请求的连接全都断开：照原来的规矩按“客户端已断开”结束', async () => {
  await scene(async (server) => {
    const first = recorder('first')
    const second = recorder('second')
    attach(server, 't', first, second)
    const asked = server.call(first, 't', 'item/tool/requestUserInput', question)
    server.closePeer(first)
    server.closePeer(second)
    await assert.rejects(asked, /客户端已断开/)
    await assert.rejects(
      server.call(first, 't', 'item/tool/requestUserInput', question),
      /没有可处理交互的已连接客户端/,
    )
  })
})

test('MULTI-PI-004：后来才订阅的连接补收到还在等的提问，原来的连接不受影响', async () => {
  await scene(async (server) => {
    const first = recorder('first')
    const late = recorder('late')
    attach(server, 't', first)
    const asked = server.call(first, 't', 'item/tool/requestUserInput', question)
    const request = first.requests()[0]
    attach(server, 't', late)
    // 补送发生在订阅它的那个请求应答之后；这里用一个无关的请求走一遍应答路径。
    await server.handle(late, { jsonrpc: '2.0', id: 1, method: 'thread/loaded/list', params: {} })
    assert.deepEqual(late.requests(), [request], '请求号与内容不变')
    assert.ok(
      late.messages.findIndex((m) => m.id === 1 && !m.method) <
        late.messages.findIndex((m) => m.id === request.id),
      '补送的请求排在应答之后',
    )
    assert.equal(first.requests().length, 1, '已经拿着的连接不重复收')
    assert.equal(first.resolved().length, 0)
    await server.handle(late, answer(request.id, '后来的来答'))
    assert.deepEqual(await asked, { answers: { q: { answers: ['后来的来答'] } } })
    assert.equal(first.resolved().length, 1)
  })
})

test('MULTI-PI-005：退订的连接不再收到回合的通知和新的提问（会话级的照收），另一条照常', async () => {
  await scene(async (server) => {
    const first = recorder('first')
    const second = recorder('second')
    attach(server, 't', first, second)
    await server.handle(second, {
      jsonrpc: '2.0',
      id: 1,
      method: 'thread/unsubscribe',
      params: { threadId: 't' },
    })
    assert.equal(second.messages.at(-1).result.status, 'unsubscribed')
    const mark = second.messages.length
    server.notify('t', 'turn/started', { turn: { id: 'u' } })
    server.notify('t', 'thread/name/updated', { threadName: '改名' })
    const asked = server.call(first, 't', 'item/tool/requestUserInput', question)
    // 改名这类会话级的通知和上游一样发给所有连接，退订了的也收到；回合的通知、新的提问不再给它
    assert.deepEqual(
      second.messages.slice(mark).map((m) => m.method),
      ['thread/name/updated'],
    )
    assert.deepEqual(
      first.messages.slice(-3).map((m) => m.method),
      ['turn/started', 'thread/name/updated', 'item/tool/requestUserInput'],
    )
    await server.handle(first, answer(first.requests()[0].id, '只有我'))
    await asked
  })
})

test('MULTI-PI-006：客户端执行的工具调用只交给一条连接，不发给别的订阅连接', async () => {
  await scene(async (server) => {
    const first = recorder('first')
    const second = recorder('second')
    attach(server, 't', first, second)
    const called = server.call(first, 't', 'item/tool/call', { tool: 'x', arguments: {} })
    assert.equal(first.requests().length, 1)
    assert.equal(second.requests().length, 0, '工具调用可能有副作用，不能两边各执行一次')
    await server.handle(second, { jsonrpc: '2.0', id: first.requests()[0].id, result: 'no' } as any)
    await server.handle(first, { jsonrpc: '2.0', id: first.requests()[0].id, result: 'ok' } as any)
    assert.equal(await called, 'ok')
  })
})

test('MULTI-PI-007：只有一条连接时，提问的往来和以前逐条相同', async () => {
  await scene(async (server) => {
    const only = recorder('only')
    attach(server, 't', only)
    const asked = server.call(only, 't', 'item/tool/requestUserInput', question)
    const request = only.requests()[0]
    assert.deepEqual(only.messages, [
      {
        jsonrpc: '2.0',
        id: request.id,
        method: 'item/tool/requestUserInput',
        params: { threadId: 't', turnId: '', itemId: request.id, ...question },
      },
    ])
    await server.handle(only, answer(request.id, '好'))
    await asked
    assert.deepEqual(only.messages.slice(1), [
      { method: 'serverRequest/resolved', params: { threadId: 't', requestId: request.id } },
    ])
  })
})
