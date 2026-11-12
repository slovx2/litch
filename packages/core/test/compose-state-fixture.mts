// 浏览器和手机预览共用真实核心与 JSON-RPC 假对端；不打开网络或个人配置。
import { type Clock, createCore } from '../src/index.mjs'
import { fakeOpener, type Handler, RpcFailure } from './fake-server.mjs'
import { thread, turn } from './fixtures.mjs'

export function composeStateFixture(clock: Clock) {
  const active = turn('working', [], {
    status: 'inProgress',
    startedAt: Math.floor(Date.now() / 1000),
  })
  const session = thread({
    id: 'nebula',
    name: '星云 · 输入验收',
    cwd: '/srv/nebula',
    turns: [active],
  })
  const compact = { type: 'contextCompaction' as const, id: 'compact' }
  Object.assign(session, { harness: 'claude' })
  let online = true
  const handlers: Record<string, Handler> = {
    'runtime/info': () => ({
      device: { home: '/home/nebula', os: 'linux', extensions: [] },
      harnesses: [
        {
          id: 'claude',
          displayName: 'Claude Code',
          badge: 'CC',
          available: true,
          version: '9.9.9',
          features: {
            steer: true,
            inputTypes: ['text', 'image'],
            steerInputTypes: ['text', 'image'],
          },
        },
      ],
    }),
    'project/list': () => ({ data: [], nextCursor: null }),
    'thread/list': () => ({ data: [session], nextCursor: null, backwardsCursor: null }),
    'thread/resume': () => ({ thread: session, model: 'nebula', reasoningEffort: null }),
    'thread/read': () => ({ thread: session }),
    'model/list': () => ({ data: [], nextCursor: null }),
    'turn/steer': () => ({ turnId: active.id }),
    'fs/createDirectory': () => ({}),
    'fs/writeFile': () => ({}),
    'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
  }
  const peer = fakeOpener(handlers)
  const core = createCore({
    clock,
    version: '9.9.9',
    devices: [
      {
        id: 'local',
        name: '星云设备',
        host: 'dev@nebula',
        kind: 'local',
        target: null,
        wire: 'green',
        open: async (signal, options) => {
          if (!online) throw new RpcFailure(-1, '隔离设备离线')
          return peer.open(signal, options)
        },
      },
    ],
  })
  const controls = {
    token: Math.random().toString(36),
    offline() {
      online = false
      peer.last().drop()
    },
    online() {
      online = true
    },
    startCompact() {
      active.items.push(compact)
      peer.last().notify('item/started', { threadId: session.id, turnId: active.id, item: compact })
    },
    finishCompact() {
      peer
        .last()
        .notify('item/completed', { threadId: session.id, turnId: active.id, item: compact })
    },
    calls() {
      return peer.servers.flatMap((server) => server.seen)
    },
  }
  core.start()
  return { core, controls }
}
