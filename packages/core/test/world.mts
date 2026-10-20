// 会话操作这一组测试共用的搭建：一个真的核心，对面是假对端。
// live.test.mts 里有一份更全的（模型、设置、引导），这里只留会话操作用得到的，方法表可以由测试补。
import type { Thread, Turn } from '../../protocol/src/index.mjs'
import { createCore, type SidebarOp, type SidebarView } from '../src/index.mjs'
import { fakeOpener, type Handler, RpcFailure } from './fake-server.mjs'
import { thread, turn } from './fixtures.mjs'
import { fakeClock } from './helpers.mjs'
import { watchSession } from './wire.mjs'

const never = { aborted: false, addEventListener() {} }

export const where = { deviceId: 'local', sessionId: 'a' }

/** 适配器的一个入口对 runtime/info 的应答。fields 是另外带的：结构化的声明之类 */
export const runtimeInfo = (fields: Record<string, unknown> = {}) => ({
  engine: 'pi',
  protocolVersion: '0.163.0',
  cliBuild: '0.99.1',
  capabilities: [],
  releaseReady: true,
  ...fields,
})

export const started = (id: string): Turn => turn(id, [], { status: 'inProgress' })
export const finished = (id: string, fields: Partial<Turn> = {}): Turn =>
  turn(id, [], { status: 'completed', durationMs: 1200, ...fields })

export function setup(
  threads: Thread[] = [thread({ id: 'a', turns: [] })],
  extra: Record<string, Handler> = {},
) {
  const world = {
    threads,
    /** 对面已经归档的会话 */
    archived: [] as Thread[],
    turnSeq: 0,
  }
  const find = (params: unknown, list = world.threads): Thread => {
    const { threadId } = params as { threadId: string }
    const found = list.find((entry) => entry.id === threadId)
    if (!found) throw new RpcFailure(-32600, 'thread not found')
    return found
  }
  const handlers: Record<string, Handler> = {
    'runtime/info': () => runtimeInfo(),
    'project/list': () => ({ data: [], nextCursor: null }),
    'model/list': () => ({ data: [], nextCursor: null }),
    'thread/list': (params) => ({
      data: ((params as { archived?: boolean }).archived ? world.archived : world.threads).map(
        (entry) => ({ ...entry, turns: [] }),
      ),
      nextCursor: null,
      backwardsCursor: null,
    }),
    // 读历史不看归没归档；订阅只给没归档的
    'thread/read': (params) => ({ thread: find(params, [...world.threads, ...world.archived]) }),
    'thread/resume': (params) => ({ thread: find(params) }),
    'thread/archive': (params) => {
      const found = find(params)
      world.threads = world.threads.filter((entry) => entry !== found)
      world.archived.push(found)
      return {}
    },
    'thread/unarchive': (params) => {
      const found = find(params, world.archived)
      world.archived = world.archived.filter((entry) => entry !== found)
      world.threads.push(found)
      return { thread: found }
    },
    'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
    'turn/start': () => ({ turn: turn(`srv-${++world.turnSeq}`, [], { status: 'inProgress' }) }),
    'turn/interrupt': () => ({}),
    ...extra,
  }
  const time = fakeClock()
  const peer = fakeOpener(handlers)
  const core = createCore({
    clock: time.clock,
    version: '9.9.9',
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
  const sidebar = { view: null as SidebarView | null, ops: [] as SidebarOp[] }
  core.subscribe(
    { kind: 'sidebar', deviceId: 'local' },
    {
      snapshot: (data) => {
        sidebar.view = data as SidebarView
      },
      delta: (ops) => sidebar.ops.push(...(ops as SidebarOp[])),
      error() {},
    },
  )
  const command = (name: string, params: object) => core.command(name, params, never)
  /** 对面收到过的某个方法的参数，按到达顺序 */
  const sent = (method: string) =>
    peer
      .last()
      .seen.filter((entry) => entry.method === method)
      .map((entry) => entry.params)
  return { core, world, peer, time, sidebar, command, sent }
}

/** 订阅一个会话，并像界面那样把增量落到快照上。经真的通道，见 wire.mts */
export const watch = watchSession
