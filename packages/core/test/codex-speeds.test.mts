// 直连原生 codex 时速度由核心按会话记住（protocol 包的 codex-speeds.mts）：codex 不保存速度，会话从磁盘重新装载过
// （codex 重启、没人订阅空闲久了被卸载）之后恢复只带会话号，选过的快速就没了。这里看：选过的跟着回合记下，
// 切走再切回来、桌面端重启（记在侧栏快照里）之后恢复带上它，界面显示的和之后发出去的都对；分叉接着源会话的；
// 连的不是原生 codex 自己（设备服务、适配器入口）时照原样发，由设备进程记。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Thread } from '../../protocol/src/index.mjs'
import { createCore, type DeviceSnapshot } from '../src/index.mjs'
import { fakeOpener, type Handler, RpcFailure } from './fake-server.mjs'
import { thread, turn } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'
import { watchSession } from './wire.mjs'

const never = { aborted: false, addEventListener() {} }
const where = { deviceId: 'local', sessionId: 'a' }

/**
 * 一个假的 codex：速度只在“装载着”的时候记得（tiers），unload() 一下就像 codex 卸载了会话、重启了一样全忘掉，
 * 恢复时报的是恢复带的、没带就是配置里的默认（null）。direct：对面不认 runtime/info，是原生 codex 自己
 */
function world(direct: boolean) {
  const threads: Thread[] = [thread({ id: 'a', turns: [turn('t1', [], { status: 'completed' })] })]
  const tiers = new Map<string, string | null>()
  const settings = (id: string) => ({
    model: 'gpt-x',
    reasoningEffort: null,
    serviceTier: tiers.get(id) ?? null,
    activePermissionProfile: ':workspace',
    sandbox: { type: 'workspaceWrite' },
  })
  const loaded = (params: unknown) => {
    const { threadId, serviceTier } = params as { threadId: string; serviceTier?: string | null }
    if (!tiers.has(threadId) || serviceTier !== undefined) tiers.set(threadId, serviceTier ?? null)
    return threadId
  }
  let turns = 0
  const handlers: Record<string, Handler> = {
    ...(direct
      ? {}
      : {
          'runtime/info': () => ({
            engine: 'pi',
            protocolVersion: '0.163.0',
            cliBuild: '0.99.1',
            capabilities: [],
            releaseReady: true,
          }),
        }),
    'thread/list': () => ({
      data: threads.map((entry) => ({ ...entry, turns: [] })),
      nextCursor: null,
      backwardsCursor: null,
    }),
    'thread/resume': (params) => {
      const id = loaded(params)
      const found = threads.find((entry) => entry.id === id)
      if (!found) throw new RpcFailure(-32600, 'thread not found')
      return { thread: found, ...settings(id) }
    },
    'thread/fork': (params) => {
      const created = thread({ id: `fork-${threads.length}`, turns: [] })
      threads.push(created)
      loaded({ ...(params as object), threadId: created.id })
      return { thread: created, ...settings(created.id) }
    },
    'model/list': () => ({
      data: [
        {
          id: 'gpt-x',
          model: 'gpt-x',
          displayName: 'GPT-X',
          description: '',
          hidden: false,
          isDefault: true,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: '',
          serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }],
          defaultServiceTier: null,
        },
      ],
      nextCursor: null,
    }),
    'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
    'turn/start': (params) => {
      const { threadId, serviceTier } = params as { threadId: string; serviceTier?: string }
      if (serviceTier !== undefined) tiers.set(threadId, serviceTier)
      return { turn: turn(`srv-${++turns}`, [], { status: 'inProgress' }) }
    },
  }
  return { handlers, unload: () => tiers.clear() }
}

function boot(handlers: Record<string, Handler>, remembered: DeviceSnapshot | null = null) {
  const time = fakeClock()
  const peer = fakeOpener(handlers)
  const saved: DeviceSnapshot[] = []
  const core = createCore({
    clock: time.clock,
    version: '9.9.9',
    store: {
      load: () => ({ localWire: null, remotes: [] }),
      save() {},
      snapshot: () => ({
        load: () => remembered,
        save: (snapshot) => saved.push(structuredClone(snapshot)),
      }),
      forget() {},
    },
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
  const sent = (method: string) =>
    peer
      .last()
      .seen.filter((entry) => entry.method === method)
      .map((entry) => entry.params as Record<string, unknown>)
  return { core, time, peer, saved, command, sent }
}

/** 发一句、等它跑完 */
async function say(app: ReturnType<typeof boot>, text: string) {
  await app.command('session.send', { ...where, text })
  await settle()
  const id = `srv-${app.sent('turn/start').length}`
  app.peer.last().notify('turn/completed', {
    threadId: 'a',
    turn: turn(id, [], { status: 'completed' }),
  })
  await settle()
}

test('直连原生 codex：选了快速，切走再切回来、桌面端重启之后恢复都带上它，显示的和之后发的都是快速', async () => {
  const codex = world(true)
  const app = boot(codex.handlers)
  app.core.start()
  await settle()
  let session = watchSession(app.core)
  await settle()
  // 没选过：恢复只带会话号
  assert.deepEqual(app.sent('thread/resume'), [{ threadId: 'a' }])

  await app.command('session.configure', { ...where, settings: { speed: 'priority' } })
  await say(app, '快点')
  assert.equal(app.sent('turn/start')[0]?.serviceTier, 'priority')

  // 切走：没人看了留一阵再退订；codex 空闲久了卸载会话，速度忘了
  session.close()
  await settle()
  app.time.advance(10 * 60_000)
  await settle()
  codex.unload()
  session = watchSession(app.core)
  await settle()
  assert.deepEqual(app.sent('thread/resume').at(-1), { threadId: 'a', serviceTier: 'priority' })
  assert.equal(session.seen.view?.settings.speed, 'priority')
  await say(app, '再来')
  assert.equal('serviceTier' in (app.sent('turn/start').at(-1) ?? {}), false, '对上了就不用再带')

  // 记在侧栏的快照里：桌面端重启（codex 也重启过）之后照样带上
  app.time.advance(5000)
  const snapshot = app.saved.at(-1) ?? null
  assert.deepEqual(snapshot?.speeds, { a: 'priority' })
  session.close()
  app.core.stop()
  codex.unload()
  const again = boot(codex.handlers, snapshot)
  again.core.start()
  await settle()
  const reopened = watchSession(again.core)
  await settle()
  assert.deepEqual(again.sent('thread/resume').at(-1), { threadId: 'a', serviceTier: 'priority' })
  assert.equal(reopened.seen.view?.settings.speed, 'priority')

  // 分叉接着源会话的速度，分叉出来的会话也记一份
  const { sessionId: fork } = (await again.command('session.fork', {
    ...where,
    turnId: 't1',
  })) as { sessionId: string }
  assert.equal(again.sent('thread/fork').at(-1)?.serviceTier, 'priority')
  again.time.advance(5000)
  assert.equal(again.saved.at(-1)?.speeds?.[fork], 'priority')

  // 改回标准：明着发 default，也照它记
  await again.command('session.configure', { ...where, settings: { speed: 'default' } })
  await say(again, '慢点')
  assert.equal(again.sent('turn/start').at(-1)?.serviceTier, 'default')
  again.time.advance(5000)
  assert.equal(again.saved.at(-1)?.speeds?.a, 'default')
  reopened.close()
})

test('连的不是原生 codex 自己（设备服务、适配器入口）：恢复照原样只带会话号，这边不记，由设备进程记', async () => {
  const codex = world(false)
  const app = boot(codex.handlers)
  app.core.start()
  await settle()
  let session = watchSession(app.core)
  await settle()
  await app.command('session.configure', { ...where, settings: { speed: 'priority' } })
  await say(app, '快点')
  assert.equal(app.sent('turn/start')[0]?.serviceTier, 'priority')
  session.close()
  await settle()
  session = watchSession(app.core)
  await settle()
  assert.deepEqual(app.sent('thread/resume').at(-1), { threadId: 'a' })
  app.time.advance(5000)
  assert.equal(app.saved.at(-1)?.speeds?.a, undefined)
  session.close()
})
