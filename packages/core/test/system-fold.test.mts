import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  blockInput,
  bucketItems,
  type FoldTurn,
  foldTurnOf,
  type ItemView,
  runOpen,
  systemMessageOf,
  systemRuns,
  type TurnView,
} from '../src/index.mjs'

// 跨回合收起（projection/system-fold.mts）：连续的系统回合和触发它们的系统消息并成一块

type Items = Record<string, ItemView>

const report = (id: string, notes = 1): ItemView => ({
  id,
  kind: 'userMessage',
  text: '',
  attachments: [],
  event: {
    kind: 'notes',
    notes: Array.from({ length: notes }, (_, n) => ({
      threadId: `child-${n}`,
      title: `子会话 ${n}`,
      status: 'completed',
      excerpt: '做完了',
    })),
  },
})
/** 一条用户消息，extra 里给事件、系统消息这些 */
const message = (id: string, extra: Record<string, unknown>): ItemView =>
  ({ id, kind: 'userMessage', text: '', attachments: [], ...extra }) as unknown as ItemView
const user = (id: string, text = '用户说的话'): ItemView => ({
  id,
  kind: 'userMessage',
  text,
  attachments: [],
})
const peer = (id: string): ItemView => ({
  id,
  kind: 'userMessage',
  text: '对方发来的话',
  attachments: [],
  peer: { name: '别的会话', session: null, bypass: false },
})
const tool = (id: string): ItemView =>
  ({
    id,
    kind: 'toolCall',
    tool: 'litch_sessions.read',
    status: 'completed',
    error: null,
    durationMs: 10,
  }) as unknown as ItemView
const text = (id: string, phase: 'commentary' | 'final' | 'unknown' = 'final'): ItemView => ({
  id,
  kind: 'agentMessage',
  text: '给用户的话',
  phase,
  status: 'completed',
})

function turnOf(
  id: string,
  items: ItemView[],
  status: TurnView['status'] = 'completed',
  extra: Partial<TurnView> = {},
): { turn: TurnView; items: Items } {
  return {
    turn: {
      id,
      status,
      itemIds: items.map((item) => item.id),
      startedAt: null,
      durationMs: 1000,
      error: null,
      ...extra,
    },
    items: Object.fromEntries(items.map((item) => [item.id, item])),
  }
}

function fold(entry: { turn: TurnView; items: Items }): FoldTurn {
  const { turn, items } = entry
  const blocks = bucketItems(
    turn.itemIds.flatMap((id) => (items[id] ? [blockInput(id, items[id])] : [])),
    { turnRunning: turn.status === 'running' },
  )
  return foldTurnOf(turn, blocks, (id) => items[id])
}

/** 每个收起块的回合，按块分组 */
function runsOf(turns: (FoldTurn | null)[]): string[][] {
  const roles = systemRuns(turns)
  const seen = new Map<string, string[]>()
  for (const role of roles.values()) seen.set(role.run.key, role.run.turnIds)
  return [...seen.values()]
}

test('系统消息：不是用户本人在对话里说的一律算；用户打的字（哪怕附着回报）不算', () => {
  assert.deepEqual(systemMessageOf(report('a', 3)), { kind: 'report', n: 3 })
  assert.deepEqual(systemMessageOf(peer('b')), { kind: 'message', n: 1 })
  assert.equal(systemMessageOf(user('c')), null)
  const attached = report('d')
  assert.equal(systemMessageOf({ ...attached, text: '我先说一句' } as ItemView), null)
  // 看板答复、规矩、议题动态、经理开始与结束：看板上的动作，不是在对话里说话
  for (const kind of [
    'manager-answers',
    'manager-rules',
    'manager-issue',
    'manager-open',
    'manager-end',
  ])
    assert.deepEqual(systemMessageOf(message(kind, { event: { kind, notes: [] } })), {
      kind: 'board',
      n: 1,
    })
  const wake = message('f', { event: { kind: 'wake', notes: [] } })
  assert.deepEqual(systemMessageOf(wake), { kind: 'other', n: 1 })
  const task = message('g', {
    text: '写日报',
    system: { kind: 'scheduledTask', task: '日报', manual: false, prompt: '写日报' },
  })
  assert.deepEqual(systemMessageOf(task), { kind: 'schedule', n: 1 })
  // 子会话简报、“在这里做”、确认后继续：Litch 替用户发的，也算
  const briefing = message('h', {
    text: '任务',
    system: {
      kind: 'briefing',
      mode: 'fresh',
      parent: { id: 'p', harness: 'codex', title: '' },
      title: '',
      background: '',
      prompt: '',
    },
  })
  assert.deepEqual(systemMessageOf(briefing), { kind: 'other', n: 1 })
  const here = message('i', { text: '做', system: { kind: 'here', title: 't', prompt: 'p' } })
  assert.deepEqual(systemMessageOf(here), { kind: 'other', n: 1 })
  // 提醒收尾对用户透明，另算
  assert.equal(systemMessageOf(message('j', { event: { kind: 'remind', notes: [] } })), null)
})

/** 空的收尾调用（Claude 经理每个回合结尾都调一次）：不画，结尾文字常排在它后面 */
const wrapUp = (id: string): ItemView =>
  ({
    id,
    kind: 'toolCall',
    tool: 'wrap_up',
    status: 'completed',
    error: null,
    durationMs: 5,
    wrapUp: { suggestions: [] },
  }) as unknown as ItemView

/**
 * Claude 经理被事件叫醒的一个回合，形状照本机真实经理会话（只取条目种类，内容是虚构的）：
 * 回报或别的会话的消息 → 读会话、发消息几个工具 →（有时）中途一段话 → 再几个工具 → 空收尾 → 结尾一段话。
 * Claude 入口的文字一律是 unknown 阶段
 */
function claudeEvent(id: string, opener: 'report' | 'peer' = 'report', mid = false) {
  return turnOf(id, [
    opener === 'report' ? report(`${id}-u`) : peer(`${id}-u`),
    tool(`${id}-read`),
    ...(mid ? [text(`${id}-mid`, 'unknown'), tool(`${id}-start`)] : []),
    tool(`${id}-send`),
    wrapUp(`${id}-wrap`),
    text(`${id}-end`, 'unknown'),
  ])
}

test('Claude 经理连续 5 个带结尾文字的事件回合：并成一块，只露最后一段结尾文字', () => {
  const turns = [
    claudeEvent('e1'),
    claudeEvent('e2', 'peer'),
    claudeEvent('e3', 'report', true),
    claudeEvent('e4'),
    claudeEvent('e5', 'peer'),
  ].map(fold)
  assert.deepEqual(runsOf(turns), [['e1', 'e2', 'e3', 'e4', 'e5']])
  const role = systemRuns(turns).get('e3')
  assert.ok(role)
  assert.equal(role.head, false)
  assert.equal(systemRuns(turns).get('e1')?.head, true)
  assert.deepEqual(role.run.shown, ['e5-end'])
  assert.deepEqual(role.run.messages, [
    { kind: 'report', n: 3 },
    { kind: 'message', n: 2 },
  ])
  // 标题行统计：系统消息、各回合的工具，以及收进去的文字（前四段结尾、e3 中途那段）
  for (const id of ['e1-u', 'e1-read', 'e3-mid', 'e3-start', 'e1-end', 'e4-end', 'e5-send'])
    assert.ok(role.run.itemIds.includes(id), id)
  assert.equal(role.run.itemIds.includes('e5-end'), false)
  assert.equal(role.run.durationMs, 5000)
})

test('单个系统回合中途有文字：整段过程连同中途文字收起，只留结尾那一段', () => {
  const shape = fold(claudeEvent('e1', 'report', true))
  assert.deepEqual(shape.texts, ['e1-mid', 'e1-end'])
  assert.deepEqual(shape.ending, ['e1-end'])
  const role = systemRuns([shape]).get('e1')
  assert.deepEqual(role?.run.shown, ['e1-end'])
  assert.ok(role?.run.itemIds.includes('e1-mid'))
  // 最后一段文字后面还跟着工具：结尾文字仍是那一段
  const tail = fold(turnOf('t', [report('t-u'), text('t-a', 'unknown'), tool('t-c')]))
  assert.deepEqual(tail.ending, ['t-a'])
  // Codex 原生阶段：commentary 在过程里，final 只留最后一个回合的
  const codex = [
    fold(turnOf('c1', [report('c1-u'), text('c1-n', 'commentary'), tool('c1-c'), text('c1-a')])),
    fold(turnOf('c2', [report('c2-u'), text('c2-n', 'commentary'), tool('c2-c'), text('c2-a')])),
  ]
  assert.deepEqual(systemRuns(codex).get('c1')?.run.shown, ['c2-a'])
})

test('中间夹着用户自己发的消息：前后切开，用户的回合不进收起块', () => {
  const turns = [
    fold(claudeEvent('e1')),
    fold(turnOf('u', [user('u1'), tool('b1'), text('b2')])),
    fold(claudeEvent('e2')),
    fold(claudeEvent('e3')),
  ]
  assert.deepEqual(runsOf(turns), [['e1'], ['e2', 'e3']])
  assert.equal(systemRuns(turns).has('u'), false)
  assert.deepEqual(systemRuns(turns).get('e1')?.run.shown, ['e1-end'])
  assert.deepEqual(systemRuns(turns).get('e2')?.run.shown, ['e3-end'])
})

test('最后几个回合没写字：露的是块里最近写的那一段；都没写就只有标题行', () => {
  const turns = [
    fold(claudeEvent('e1')),
    fold(turnOf('t2', [report('r2'), tool('a2')])),
    fold(turnOf('t3', [report('r3'), tool('a3')])),
  ]
  assert.deepEqual(systemRuns(turns).get('t3')?.run.shown, ['e1-end'])
  const silent = [fold(turnOf('t4', [report('r4'), tool('a4')]))]
  assert.deepEqual(systemRuns(silent).get('t4')?.run.shown, [])
})

test('正在跑、出错、被打断的系统回合照常单独画，结束后才并进前面的块', () => {
  const t1 = fold(claudeEvent('e1'))
  const running = claudeEvent('e2')
  running.turn.status = 'running'
  assert.deepEqual(runsOf([t1, fold(running)]), [['e1']])
  running.turn.status = 'completed'
  const joined = systemRuns([t1, fold(running)])
  assert.deepEqual(joined.get('e1')?.run.turnIds, ['e1', 'e2'])
  // 并进来之后，前一个回合的结尾文字收进块里，露的换成新回合的
  assert.deepEqual(joined.get('e1')?.run.shown, ['e2-end'])
  const failed = fold(turnOf('t3', [report('r3'), tool('a3')], 'failed'))
  const t4 = fold(claudeEvent('e4'))
  assert.deepEqual(runsOf([t1, failed, t4]), [['e1'], ['e4']])
  // 还有子代理没做完的也先不收
  assert.deepEqual(runsOf([t1, { ...t4, agentsRunning: true }]), [['e1']])
})

test('自发回合、跑着时插进来的回报、用户插话、对用户透明的提醒回合、查找时的跳行', () => {
  // 后台任务结束开的回合没有开场消息，本身算一条
  const background = fold(turnOf('b', [tool('x1')], 'completed', { origin: 'backgroundTask' }))
  assert.deepEqual(background.messages, [{ kind: 'background', n: 1 }])
  // 开头是后台任务结束的那条（核心按 litchOrigin 认出来的事件）：算这一条，不重复算回合本身
  const completed = fold(
    turnOf(
      'bc',
      [message('bc-u', { event: { kind: 'background-completed', notes: [] } }), tool('x2')],
      'completed',
      { origin: 'backgroundTask' },
    ),
  )
  assert.deepEqual(completed.messages, [{ kind: 'background', n: 1 }])
  // 自发回合开头是用户插的话：照用户消息切开
  const steeredByUser = fold(
    turnOf('bu', [user('bu-u'), tool('x3')], 'completed', { origin: 'backgroundTask' }),
  )
  assert.equal(steeredByUser.messages, null)
  // 跑着时又插进来一条回报：照样算进来
  const steered = fold(turnOf('s', [report('r1'), tool('a1'), report('r2'), tool('a2')]))
  assert.deepEqual(steered.messages, [{ kind: 'report', n: 2 }])
  // 跑着时用户插了话：用户参与的回合，照旧单独画
  const mixed = fold(turnOf('m', [report('r3'), tool('a3'), user('u1'), tool('a4')]))
  assert.equal(mixed.messages, null)
  // 目标续做（代发输入藏起来了）：回合本身算一条
  assert.deepEqual(fold(turnOf('g', [tool('g1')], 'completed', { origin: 'goal' })).messages, [
    { kind: 'goal', n: 1 },
  ])
  // 看板答复开的回合和回报连成一块
  const answers = fold(
    turnOf('a', [message('a-u', { event: { kind: 'manager-answers', notes: [] } }), tool('a1')]),
  )
  assert.deepEqual(runsOf([fold(claudeEvent('e0')), answers]), [['e0', 'a']])
  // 提醒收尾的回合什么都不画：不打断
  const remind = fold(turnOf('remind', [message('rm', { event: { kind: 'remind', notes: [] } })]))
  assert.equal(remind.hidden, true)
  const after = fold(claudeEvent('e9'))
  assert.deepEqual(runsOf([background, remind, after]), [['b', 'e9']])
  assert.deepEqual(runsOf([background, null, after]), [['b'], ['e9']])
})

test('开合：成员里有一个开着就开；都没开、有一个点收就收；都没点过照默认', () => {
  assert.equal(runOpen([undefined, undefined], false), false)
  assert.equal(runOpen([undefined, undefined], true), true)
  assert.equal(runOpen([false, true], false), true)
  assert.equal(runOpen([false, undefined], true), false)
})
