import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CLIENT_TOOL_NAMESPACE } from '../../protocol/src/client-tools.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { PiServer } from '../src/server.mjs'

// 客户端工具（clientTools 扩展，protocol/extensions/client-tools.json）的执行方怎么挑：
// litch_ 开头的命名空间只交给握手时声明了它的连接——发起回合的那条优先，其次最早订阅、声明了的那条；
// 都没有就当场回 noExecutor 失败，不交给没声明的连接。别的命名空间照旧（MULTI-PI-006）。
// 直接对着服务对象测分发，和 multi-subscriber.test.mts 一样。

interface Recorder extends RpcPeer {
  messages: any[]
  calls(): any[]
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
    calls: () => messages.filter((m) => m.method === 'item/tool/call' && m.id !== undefined),
  }
}

const LITCH = { litchExtensions: ['clientTools'], litchClientTools: { namespaces: ['litch_echo'] } }
const OTHER = {
  litchExtensions: ['clientTools'],
  litchClientTools: { namespaces: ['litch_browser'] },
}
const UNDECLARED = { litchClientTools: { namespaces: ['litch_echo'] } }
const OK = { success: true, contentItems: [{ type: 'inputText', text: '42' }] }
const echo = { callId: 'c-1', namespace: 'litch_echo', tool: 'echo', arguments: { a: 1 } }

async function scene(run: (server: PiServer) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-client-tools-'))
  const server = new PiServer(root)
  try {
    await run(server)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}

/** 握手（带上声明），再订阅会话 t */
async function join_(server: PiServer, peer: Recorder, capabilities: unknown = null) {
  await server.handle(peer, {
    jsonrpc: '2.0',
    id: `init-${peer.id}`,
    method: 'initialize',
    params: { clientInfo: { name: peer.id, title: null, version: '1' }, capabilities },
  } as any)
  peer.messages.length = 0
  server.subscribe(peer, 't')
  return peer
}

const reply = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result }) as any

test('CLIENT-TOOLS-PI-001：发起回合的连接声明了，调用交给它；参数照上游的形状，不带 itemId', async () => {
  await scene(async (server) => {
    const starter = await join_(server, recorder('starter'), LITCH)
    const other = await join_(server, recorder('other'), LITCH)
    const called = server.call(starter, 't', 'item/tool/call', echo)
    assert.equal(other.calls().length, 0)
    const [call] = starter.calls()
    assert.deepEqual(call.params, { threadId: 't', turnId: '', ...echo })
    await server.handle(starter, reply(call.id, OK))
    assert.deepEqual(await called, OK)
  })
})

test('CLIENT-TOOLS-PI-002：发起回合的连接没声明，交给最早订阅、声明了的连接', async () => {
  await scene(async (server) => {
    const desktop = await join_(server, recorder('desktop'))
    const other = await join_(server, recorder('other'), OTHER)
    const litch = await join_(server, recorder('litch'), LITCH)
    const late = await join_(server, recorder('late'), LITCH)
    const called = server.call(desktop, 't', 'item/tool/call', echo)
    for (const peer of [desktop, other, late]) assert.equal(peer.calls().length, 0, peer.id)
    const [call] = litch.calls()
    await server.handle(litch, reply(call.id, OK))
    assert.deepEqual(await called, OK)
  })
})

test('CLIENT-TOOLS-PI-003：没有声明了的连接，当场回 noExecutor，谁都收不到', async () => {
  await scene(async (server) => {
    const desktop = await join_(server, recorder('desktop'))
    const loose = await join_(server, recorder('loose'), UNDECLARED)
    const result = await server.call(desktop, 't', 'item/tool/call', echo)
    for (const peer of [desktop, loose]) assert.equal(peer.calls().length, 0, peer.id)
    assert.equal(result.success, false)
    assert.match(result.contentItems[0].text, /^\[litch:noExecutor\] .*litch_echo/)
  })
})

test('CLIENT-TOOLS-PI-004：挑中的执行方断开，调用按失败结束，不改交给别的声明了的连接', async () => {
  await scene(async (server) => {
    const litch = await join_(server, recorder('litch'), LITCH)
    const spare = await join_(server, recorder('spare'), LITCH)
    const called = server.call(litch, 't', 'item/tool/call', echo)
    assert.equal(litch.calls().length, 1)
    server.closePeer(litch)
    await assert.rejects(called, /客户端已断开/)
    assert.equal(spare.calls().length, 0)
  })
})

test('CLIENT-TOOLS-PI-005：别的命名空间照旧交给发起回合的连接，不看声明', async () => {
  await scene(async (server) => {
    const desktop = await join_(server, recorder('desktop'))
    const litch = await join_(server, recorder('litch'), LITCH)
    const called = server.call(desktop, 't', 'item/tool/call', { ...echo, namespace: 'files' })
    assert.equal(litch.calls().length, 0)
    const [call] = desktop.calls()
    assert.equal('itemId' in call.params, false)
    await server.handle(desktop, reply(call.id, OK))
    assert.deepEqual(await called, OK)
  })
})

test('CLIENT-TOOLS-PI-006：litch_sessions 照同一套规矩：设备进程替上游连接声明了的收得到，只声明了浏览器的收不到', async () => {
  await scene(async (server) => {
    const sessions = CLIENT_TOOL_NAMESPACE.sessions
    // 回合由只声明了浏览器的连接发起；设备进程替另一条（官方桌面端）声明了 litch_sessions
    const browserOnly = await join_(server, recorder('browser-only'), OTHER)
    const official = await join_(server, recorder('official'), {
      litchExtensions: ['clientTools'],
      litchClientTools: { namespaces: [sessions] },
    })
    const called = server.call(browserOnly, 't', 'item/tool/call', {
      ...echo,
      namespace: sessions,
      tool: 'list',
    })
    assert.equal(browserOnly.calls().length, 0)
    const [call] = official.calls()
    assert.equal(call.params.namespace, sessions)
    await server.handle(official, reply(call.id, OK))
    assert.deepEqual(await called, OK)
    // 浏览器的调用照旧交给声明了浏览器的那条，不会因为它声明了 litch_sessions 落到官方桌面端
    const browsing = server.call(browserOnly, 't', 'item/tool/call', {
      ...echo,
      callId: 'c-2',
      namespace: 'litch_browser',
    })
    assert.equal(official.calls().length, 1)
    const [browse] = browserOnly.calls()
    await server.handle(browserOnly, reply(browse.id, OK))
    assert.deepEqual(await browsing, OK)
  })
})
