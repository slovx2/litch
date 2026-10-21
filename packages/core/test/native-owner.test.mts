// 导进来的原生会话被本机另一个进程开着（扩展 nativeOwner）：打开时只读并说明原因，对方的进展照常出来，
// 放手后自动恢复可写。对着假对端跑，不连任何真的东西。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Thread } from '../../protocol/src/index.mjs'
import { createCore } from '../src/index.mjs'
import { fakeOpener, type Handler, RpcFailure } from './fake-server.mjs'
import { agentText, thread, turn, userText } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'
import { watchSession } from './wire.mjs'

const never = { aborted: false, addEventListener() {} }
const where = { deviceId: 'local', sessionId: 'a' }

function setup(threads: Thread[]) {
  const handlers: Record<string, Handler> = {
    'runtime/info': () => ({
      engine: 'claude-code',
      protocolVersion: '0.163.0',
      cliBuild: '2.1.282',
      capabilities: [],
      releaseReady: true,
    }),
    'project/list': () => ({ data: [], nextCursor: null }),
    'thread/list': () => ({
      data: threads.map((entry) => ({ ...entry, turns: [] })),
      nextCursor: null,
      backwardsCursor: null,
    }),
    'thread/resume': (params) => {
      const found = threads.find((entry) => entry.id === (params as { threadId: string }).threadId)
      if (!found) throw new RpcFailure(-32600, 'thread not found')
      return {
        thread: found,
        model: 'opus',
        reasoningEffort: 'high',
        sandbox: { type: 'dangerFullAccess' },
      }
    },
    'model/list': () => ({ data: [], nextCursor: null }),
    'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
    'turn/start': () => ({ turn: turn('srv-1', [], { status: 'inProgress' }) }),
  }
  const time = fakeClock()
  const peer = fakeOpener(handlers)
  const core = createCore({
    clock: time.clock,
    version: '9.9.9',
    log: () => {},
    devices: [
      {
        id: 'local',
        name: '本机',
        host: 'dev@mac',
        kind: 'local',
        target: null,
        wire: 'green',
        open: peer.open,
      },
    ],
  })
  const command = (name: string, params: object) => core.command(name, params, never)
  return { core, peer, command }
}

const owned = (fields: Partial<Thread> = {}) =>
  ({
    ...thread({ id: 'a', turns: [turn('u1', [userText('u1:user', '桌面端说的第一句')])] }),
    litchNativeOwner: { entrypoint: 'claude-desktop', running: true },
    ...fields,
  }) as Thread

test('NATIVE-OWNER-001：握手声明 nativeOwner；被占着的会话只读并说明原因，对方的回合照常出来；放手后恢复可写', async () => {
  const { core, peer, command } = setup([owned()])
  core.start()
  await settle()
  const declared = peer.last().seen.find((entry) => entry.method === 'initialize')?.params as {
    capabilities: { litchExtensions: string[] }
  }
  assert.ok(declared.capabilities.litchExtensions.includes('nativeOwner'))

  const session = watchSession(core)
  await settle()
  assert.equal(session.seen.view?.live, false)
  assert.deepEqual(session.seen.view?.note, { key: 'session.nativeOwned' })
  await assert.rejects(command('session.send', { ...where, text: '这边插一句' }), /只读/)

  // 对方跑完一轮：入口重画后整个回合一次发过来
  const server = peer.last()
  server.notify('turn/completed', {
    threadId: 'a',
    turn: turn('u2', [userText('u2:user', '桌面端的第二句'), agentText('a2:0', '桌面端的回答')]),
  })
  await settle()
  assert.deepEqual(
    session.seen.view?.turns.map((entry) => entry.id),
    ['u1', 'u2'],
  )

  // 对方放手：恢复可写，原因的话收起来
  server.notify('litch/thread/nativeOwner/changed', { threadId: 'a', owner: null })
  await settle()
  assert.equal(session.seen.view?.live, true)
  assert.equal(session.seen.view?.note, null)

  // 又被占上
  server.notify('litch/thread/nativeOwner/changed', {
    threadId: 'a',
    owner: { entrypoint: 'cli', running: false },
  })
  await settle()
  assert.equal(session.seen.view?.live, false)
  assert.deepEqual(session.seen.view?.note, { key: 'session.nativeOwned' })
})

test('NATIVE-OWNER-002：别的原因只读的会话（引擎自己的子代理）不因为占用解除就变成可写', async () => {
  const { core, peer } = setup([
    { ...thread({ id: 'a', turns: [] }), canAcceptDirectInput: false } as Thread,
  ])
  core.start()
  await settle()
  const session = watchSession(core)
  await settle()
  assert.equal(session.seen.view?.live, false)
  peer.last().notify('litch/thread/nativeOwner/changed', { threadId: 'a', owner: null })
  await settle()
  assert.equal(session.seen.view?.live, false)
  assert.deepEqual(session.seen.view?.note, { key: 'session.agentReadOnly' })
})
