// 工具调用的结果很大：经整条链路（假的对面 → 真的核心 → 真的通道 → 界面的数据副本）看三条路（实时、读历史、中途恢复）
// 得到的工具条目是不是同一个样子，核心和界面各留着多少、重新订阅时的快照多大、通道上发了多少。
// 改之前结果整段留着（几 MB 的文字原样到界面），下面的大小断言都不过。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Thread, ThreadItem } from '../../protocol/src/index.mjs'
import {
  connectChannel,
  createPortPair,
  createReplica,
  type ItemView,
  keys,
  OUTPUT_KEEP,
  type SessionView,
  serveChannel,
  type ToolCallItem,
  type TurnView,
} from '../src/index.mjs'
import { thread, turn } from './fixtures.mjs'
import { settle } from './helpers.mjs'
import { setup, started, where } from './world.mjs'

type World = ReturnType<typeof setup>

/** 一行一行的结果，每行带着序号，夹一点非 ASCII 的字：省掉的字节数和字数不一样 */
function rows(count: number): string {
  let text = ''
  for (let n = 1; n <= count; n++) text += `[${String(n).padStart(7, '0')}] 第 ${n} 行 … ok\n`
  return text
}

const RESULT = {
  content: [
    { type: 'text', text: rows(200_000) },
    { type: 'image', data: 'A'.repeat(1024 * 1024), mimeType: 'image/png' },
    ...Array.from({ length: 3000 }, (_, n) => ({ type: 'text', text: `第 ${n} 段` })),
    { type: 'text', text: '最后一段' },
  ],
  structuredContent: null,
  _meta: null,
}

const call = (status: 'inProgress' | 'completed'): ThreadItem => ({
  type: 'mcpToolCall',
  id: 'm1',
  server: 'db',
  tool: 'dump',
  status,
  arguments: { table: 'events' },
  appContext: null,
  mcpAppUi: null,
  pluginId: null,
  readOnlyHint: null,
  result: status === 'completed' ? RESULT : null,
  error: null,
  durationMs: status === 'completed' ? 900 : null,
})

/** 把会话经真的通道接到界面的数据副本上，顺手数通道上一共发了多少字 */
function screen(world: World) {
  const [uiPort, corePort] = createPortPair()
  let wire = 0
  const post = corePort.post.bind(corePort)
  corePort.post = (message) => {
    wire += JSON.stringify(message).length
    post(message)
  }
  serveChannel(corePort, world.core, { clock: world.time.clock })
  const replica = createReplica(connectChannel(uiPort))
  replica.openSession(where.deviceId, where.sessionId)
  const { store } = replica
  const item = (): ToolCallItem | null => {
    for (const turnId of store.get<string[]>(keys.turnIds(where.deviceId, where.sessionId)) ?? []) {
      const entry = store.get<TurnView>(keys.turn(where.deviceId, where.sessionId, turnId))
      for (const id of entry?.itemIds ?? []) {
        const found = store.get<ItemView>(keys.item(where.deviceId, where.sessionId, id))
        if (found?.kind === 'toolCall') return found
      }
    }
    return null
  }
  return { wire: () => wire, item }
}

/** 核心手里那一份：另开一个订阅拿快照（切走再切回来、重连之后界面重新订阅，拿到的就是它） */
function snapshot(world: World): SessionView {
  let view: SessionView | null = null
  const stop = world.core.subscribe(
    { kind: 'session', ...where },
    { snapshot: (data) => (view = data as SessionView), delta() {}, error() {} },
  )
  stop()
  assert.ok(view, '会话开着，快照应当当场给')
  return view
}

const frame = async (world: World) => {
  world.time.advance(16)
  await settle()
}

/** 打开会话 a，看那条工具调用在核心和界面的副本里各是什么样子 */
async function opened(threads: Thread[], feed?: (world: World) => Promise<void>) {
  const world = setup(threads)
  world.core.start()
  await settle()
  const ui = screen(world)
  await settle()
  await frame(world)
  const before = ui.wire()
  await feed?.(world)
  const view = snapshot(world)
  const core = Object.values(view.items).find((entry) => entry.kind === 'toolCall')
  const seen = ui.item()
  assert.ok(core?.kind === 'toolCall' && seen, '核心和界面的副本里都应当有那条工具调用')
  return { core, ui: seen, sent: ui.wire() - before, snapshot: JSON.stringify(view).length }
}

test('工具结果很大：实时、读历史、中途恢复三条路得到的条目一模一样，留着的、发的、快照都只有上限那么大', async () => {
  // 一、实时：回合里调一次工具，开始时没有结果，完成时整段给
  const live = await opened([thread({ id: 'a', turns: [] })], async (world) => {
    await world.command('session.send', { ...where, text: '导出表' })
    await settle()
    const server = world.peer.last()
    const base = { threadId: 'a', turnId: 'srv-1' }
    server.notify('turn/started', { threadId: 'a', turn: started('srv-1') })
    server.notify('item/started', { ...base, item: call('inProgress'), startedAtMs: 0 })
    await settle()
    await frame(world)
    server.notify('item/completed', { ...base, item: call('completed'), completedAtMs: 1 })
    await settle()
    await frame(world)
  })

  // 二、读历史：回合已经结束
  const read = await opened([thread({ id: 'a', turns: [turn('t1', [call('completed')])] })])

  // 三、中途恢复：恢复时工具还在跑，之后才完成
  const resumed = await opened(
    [thread({ id: 'a', turns: [turn('t1', [call('inProgress')], { status: 'inProgress' })] })],
    async (world) => {
      world.peer.last().notify('item/completed', {
        threadId: 'a',
        turnId: 't1',
        item: call('completed'),
        completedAtMs: 1,
      })
      await settle()
      await frame(world)
    },
  )

  // 那张图片夹在大段文字和三千小段之间，落在省掉的那一段里
  const gap = read.core.output.find((part) => part.kind === 'gap')
  assert.ok(gap?.kind === 'gap' && gap.parts === 1 && gap.bytes > 4 * 1024 * 1024, '中间省过')
  const last = read.core.output.at(-1)
  assert.ok(last?.kind === 'text' && last.text === '最后一段')
  for (const [name, got] of [
    ['实时', live],
    ['读历史', read],
    ['中途恢复', resumed],
  ] as const) {
    // 看着它开始、结束的时刻（span）只有实时、中途恢复的有，不比
    const { id: _core, span: _coreSpan, ...core } = got.core as ItemView
    const { id: _ui, span: _uiSpan, ...ui } = got.ui as ItemView
    const { id: _read, ...expected } = read.core
    assert.deepEqual(core, expected, `${name}：核心里的样子和读历史的不一样`)
    assert.deepEqual(ui, expected, `${name}：界面的副本和读历史的不一样`)
    assert.ok(
      got.snapshot <= OUTPUT_KEEP + 20_000,
      `${name}：重新订阅时的快照有 ${got.snapshot} 个字`,
    )
  }
  // 结果到了之后通道上发的是截过的条目，不是整段结果
  for (const [name, got] of [
    ['实时', live],
    ['中途恢复', resumed],
  ] as const) {
    assert.ok(got.sent <= OUTPUT_KEEP + 20_000, `${name}：通道上发了 ${got.sent} 个字`)
  }
})
