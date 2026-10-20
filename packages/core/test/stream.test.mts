// 流式内容经通道到界面：增量在通道里最多排一帧才发出去，这期间核心还在往同一个条目上加字。
// 界面那头按收到的消息还原出来的，必须和对面发的一字不差。
// 这里走的是真的通道（同线程的端口、假的时钟）和界面用的那份数据副本，不是当场取值的测试辅助。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ThreadItem } from '../../protocol/src/index.mjs'
import {
  type Clock,
  type CoreHost,
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  type ItemView,
  keys,
  reduceSession,
  type SessionOp,
  type SessionView,
  serveChannel,
  type TurnView,
} from '../src/index.mjs'
import { SAMPLE_TEXT } from '../src/mock/sample-text.mjs'
import { ALL_ABLE } from '../src/projection/session.mjs'
import { agentText } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'
import { setup, started, where } from './world.mjs'

const FRAME = 16

/** 把一个会话经真的通道接到界面的数据副本上 */
function screen(host: CoreHost, clock: Clock, at = where) {
  const [uiPort, corePort] = createPortPair()
  serveChannel(corePort, host, { clock })
  const channel = connectChannel(uiPort)
  const replica = createReplica(channel)
  replica.openSession(at.deviceId, at.sessionId)
  const { store } = replica
  const turns = () =>
    (store.get<string[]>(keys.turnIds(at.deviceId, at.sessionId)) ?? []).flatMap(
      (id) => store.get<TurnView>(keys.turn(at.deviceId, at.sessionId, id)) ?? [],
    )
  const item = (id: string) => store.get<ItemView>(keys.item(at.deviceId, at.sessionId, id))
  /** 每个回合里各条目的文字；命令给它的输出，别的没有文字的给种类 */
  const texts = () =>
    turns().map((turn) =>
      turn.itemIds.map((id) => {
        const entry = item(id)
        if (entry?.kind === 'command') return entry.output
        return entry && 'text' in entry ? entry.text : entry?.kind
      }),
    )
  return { channel, texts, turns }
}

const command = (id: string, output: string): ThreadItem => ({
  type: 'commandExecution',
  id,
  pluginId: null,
  scriptPath: null,
  command: 'ls',
  cwd: '/work/app',
  processId: null,
  source: 'agent',
  status: 'inProgress',
  commandActions: [],
  aggregatedOutput: output,
  exitCode: null,
  durationMs: null,
})

/** 起一个真的核心，打开会话 a，发一句话，对面开始一个回合 */
async function running() {
  const world = setup()
  world.core.start()
  await settle()
  const ui = screen(world.core, world.time.clock)
  await settle()
  await world.command('session.send', { ...where, text: '你好' })
  await settle()
  const server = world.peer.last()
  const base = { threadId: 'a', turnId: 'srv-1' }
  server.notify('turn/started', { threadId: 'a', turn: started('srv-1') })
  await settle()
  /** 过一帧：排着的增量发出去，到界面 */
  const frame = async () => {
    world.time.advance(FRAME)
    await settle()
  }
  await frame()
  return { ...world, ui, server, base, frame }
}

test('流式文字：条目开始和头几段增量挤在同一帧里，界面还原出来的和对面发的一字不差', async () => {
  const { ui, server, base, frame } = await running()
  server.notify('item/started', { ...base, item: agentText('m1', ''), startedAtMs: 0 })
  server.notify('item/agentMessage/delta', { ...base, itemId: 'm1', delta: '收到：' })
  server.notify('item/agentMessage/delta', { ...base, itemId: 'm1', delta: '你好' })
  await settle()
  assert.deepEqual(ui.texts(), [['你好']], '这一帧还没过完，增量还排着')
  await frame()
  assert.deepEqual(ui.texts(), [['你好', '收到：你好']])

  server.notify('item/agentMessage/delta', { ...base, itemId: 'm1', delta: '。' })
  await settle()
  await frame()
  assert.deepEqual(ui.texts(), [['你好', '收到：你好。']])
})

test('流式文字：条目开始时已经带着的字算在前头，同一帧里的增量接着加，不多不少', async () => {
  const { ui, server, base, frame } = await running()
  server.notify('item/started', { ...base, item: agentText('m1', '收到'), startedAtMs: 0 })
  server.notify('item/agentMessage/delta', { ...base, itemId: 'm1', delta: '：你好' })
  await settle()
  await frame()
  assert.deepEqual(ui.texts(), [['你好', '收到：你好']])
})

test('流式文字：对面没发“开始”就直接出字，补上的空条目和这段字不会合成两遍', async () => {
  const { ui, server, base, frame } = await running()
  server.notify('item/agentMessage/delta', { ...base, itemId: 'm1', delta: '收到：' })
  server.notify('item/reasoning/summaryTextDelta', {
    ...base,
    itemId: 'r1',
    summaryIndex: 0,
    delta: '先想一想',
  })
  await settle()
  await frame()
  assert.deepEqual(ui.texts(), [['你好', '收到：', '先想一想']])
})

test('命令输出：开始和头几段输出挤在同一帧里，界面上的输出不多不少', async () => {
  const { ui, server, base, frame } = await running()
  server.notify('item/started', { ...base, item: command('c1', ''), startedAtMs: 0 })
  for (const delta of ['a.txt\n', 'b.txt\n']) {
    server.notify('item/commandExecution/outputDelta', { ...base, itemId: 'c1', delta })
  }
  await settle()
  await frame()
  assert.deepEqual(ui.texts(), [['你好', 'a.txt\nb.txt\n']])
})

test('模拟核心：回话出得比一帧还快时，界面上的字始终是最终文字的前头一截', async () => {
  const time = fakeClock()
  const host = createMockCore({ clock: time.clock, chunkMs: 5 })
  const at = { deviceId: 'local', sessionId: 's6' }
  const ui = screen(host, time.clock, at)
  await settle()
  const before = ui.turns().length
  assert.ok(before > 0, '示例会话的内容应当已经到了')
  await ui.channel.command('session.send', { ...at, text: '随便说点什么' })
  await settle()
  /** 新回合里回答的文字。回合还没到界面、回答还没开始时是空的 */
  const answer = () => {
    const last = ui.turns().length > before ? (ui.texts().at(-1) ?? []) : []
    return last.length > 1 ? String(last.at(-1)) : ''
  }
  const seen: string[] = []
  for (let step = 0; step < 4000; step++) {
    time.advance(1)
    await settle()
    const now = answer()
    if (now !== seen.at(-1)) seen.push(now)
    if (ui.turns().length > before && ui.turns().at(-1)?.status === 'completed') break
  }
  const final = seen.at(-1) ?? ''
  // 模拟核心的回答没有“定稿时整条换掉”这一步，全靠增量拼出来：多加一遍就一直错下去
  assert.equal(final, SAMPLE_TEXT['zh-CN'].mockReply)
  assert.ok(seen.length > 3, '回话应当是分几次到的')
  for (const partial of seen) {
    assert.ok(final.startsWith(partial), `中途出现过不是最终文字开头的内容：${partial}`)
  }
})

test('归并：增量带来的对象拷一份再放进视图，之后视图怎么变都不动那条增量', () => {
  const view: SessionView = {
    deviceId: 'd',
    sessionId: 's',
    title: 't',
    harness: 'pi',
    cwd: '~',
    live: true,
    note: null,
    turns: [],
    items: {},
    requests: [],
    queued: [],
    settings: { model: null, effort: null, permission: null, mode: null },
    usage: null,
    can: { ...ALL_ABLE },
    forkedFrom: null,
    proposals: [],
    agents: [],
  }
  const ops: SessionOp[] = [
    {
      op: 'turn.add',
      turn: {
        id: 't1',
        status: 'running',
        itemIds: [],
        startedAt: 1,
        durationMs: null,
        error: null,
      },
    },
    {
      op: 'item.add',
      turnId: 't1',
      item: { id: 'a', kind: 'agentMessage', text: '', phase: 'final', status: 'inProgress' },
    },
    {
      op: 'item.add',
      turnId: 't1',
      item: {
        id: 'c',
        kind: 'command',
        command: 'ls',
        cwd: '~',
        output: '',
        elided: null,
        exitCode: null,
        durationMs: null,
        startedAt: null,
        status: 'inProgress',
      },
    },
  ]
  const before = structuredClone(ops)
  for (const op of ops) reduceSession(view, op)
  reduceSession(view, { op: 'item.appendText', itemId: 'a', field: 'text', text: '字' })
  reduceSession(view, { op: 'item.appendText', itemId: 'c', field: 'output', text: '输出' })
  reduceSession(view, { op: 'item.status', itemId: 'a', status: 'completed' })
  reduceSession(view, { op: 'turn.status', turnId: 't1', status: 'completed', durationMs: 5 })
  assert.deepEqual(ops, before)
  assert.deepEqual(view.turns, [
    {
      id: 't1',
      status: 'completed',
      itemIds: ['a', 'c'],
      startedAt: 1,
      durationMs: 5,
      error: null,
    },
  ])
  assert.equal((view.items.a as { text: string }).text, '字')
  assert.equal((view.items.c as { output: string }).output, '输出')
})
