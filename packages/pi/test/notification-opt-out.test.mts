import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { PiServer } from '../src/server.mjs'

// 握手里的 capabilities.optOutNotificationMethods（上游协议里就有）：客户端退订的通知，这条连接上不发。
// 共用的那个函数的用例在 packages/claude/test/notification-opt-out.test.mts，这里守着 Pi 的入口照它做了：
// 直接对着服务对象测，一条连接退订、一条不退订，两边对照。

interface Recorder extends RpcPeer {
  messages: any[]
  notifications(method: string): any[]
  reply(id: unknown): any
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
    notifications: (method) => messages.filter((m) => m.method === method && m.id === undefined),
    reply: (requestId) => messages.find((m) => m.id === requestId && !m.method),
  }
}

async function scene(run: (server: PiServer, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-opt-out-'))
  const server = new PiServer(root)
  try {
    await run(server, root)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}

let sequence = 0
async function request(server: PiServer, peer: Recorder, method: string, params: unknown) {
  const id = `${peer.id}:${++sequence}`
  await server.handle(peer, { jsonrpc: '2.0', id, method, params })
  const reply = peer.reply(id)
  assert.ok(reply, `${peer.id} 没有收到 ${method} 的应答`)
  assert.equal(reply.error, undefined, `${method}: ${JSON.stringify(reply.error)}`)
  return reply.result
}

const handshake = (server: PiServer, peer: Recorder, optOutNotificationMethods?: string[]) =>
  request(server, peer, 'initialize', {
    clientInfo: { name: peer.id, title: null, version: '1.0.0' },
    capabilities: { experimentalApi: true, optOutNotificationMethods },
  })

const QUESTION = 'item/tool/requestUserInput'

test('OPTOUT-PI-001：退订的通知这条连接收不到，别的连接照收；应答和名单上的服务端请求照发', async () => {
  await scene(async (server, root) => {
    const loud = recorder('loud')
    const quiet = recorder('quiet')
    await handshake(server, loud)
    await handshake(server, quiet, ['project/changed', 'thread/name/updated', 'turn', QUESTION])
    for (const peer of [loud, quiet]) server.subscribe(peer, 't')

    // 广播的通知（真实的请求路径）：建项目的是退订了的那条，应答照回，变更通知只有没退订的收到
    const created = await request(server, quiet, 'project/create', {
      idempotencyKey: 'opt-out',
      name: '退订',
      roots: [{ path: root }],
    })
    assert.equal(created.project.name, '退订')
    assert.equal(loud.notifications('project/changed').length, 1)
    assert.equal(quiet.notifications('project/changed').length, 0)

    // 会话的通知：名单上的不发；名单里的 turn 只是别的方法名的前缀，不算
    server.notify('t', 'thread/name/updated', { threadName: '改名' })
    server.notify('t', 'turn/started', { turn: { id: 'u' } })
    assert.equal(loud.notifications('thread/name/updated').length, 1)
    assert.equal(quiet.notifications('thread/name/updated').length, 0)
    assert.equal(loud.notifications('turn/started').length, 1)
    assert.equal(quiet.notifications('turn/started').length, 1)

    // 提问的方法名在名单上，但它是请求：照样送到，退订了的这条连接来答也算数
    const asked = server.call(loud, 't', QUESTION, { isBlocking: true, questions: [] })
    const pending = quiet.messages.find((m) => m.method === QUESTION && m.id !== undefined)
    assert.ok(pending, '退订了通知的连接照样收到服务端请求')
    await server.handle(quiet, {
      jsonrpc: '2.0',
      id: pending.id,
      result: { answers: { q: { answers: ['好'] } } },
    })
    assert.deepEqual(await asked, { answers: { q: { answers: ['好'] } } })
    for (const peer of [loud, quiet])
      assert.equal(peer.notifications('serverRequest/resolved').length, 1, peer.id)
  })
})

test('OPTOUT-PI-002：共用层发的通知（命令的流式输出）也按名单拦，命令的结果照回', async () => {
  await scene(async (server, root) => {
    const run = (peer: Recorder) =>
      request(server, peer, 'command/exec', {
        command: ['/bin/sh', '-c', 'printf opted'],
        cwd: root,
        processId: `${peer.id}-command`,
        streamStdoutStderr: true,
      })
    const loud = recorder('loud')
    const quiet = recorder('quiet')
    await handshake(server, loud)
    // 官方桌面端退订的就有这一个
    await handshake(server, quiet, ['command/exec/outputDelta'])
    assert.equal((await run(loud)).exitCode, 0)
    assert.equal((await run(quiet)).exitCode, 0)
    assert.ok(loud.notifications('command/exec/outputDelta').length > 0)
    assert.equal(quiet.notifications('command/exec/outputDelta').length, 0)
  })
})
