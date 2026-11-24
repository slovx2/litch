import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  blockInput,
  bucketItems,
  type FoldTurn,
  foldTurnOf,
  governedSegments,
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

test('系统消息：回报、会话间消息、定时任务算；用户自己的话（哪怕附着回报）、简报、看板答复不算', () => {
  assert.deepEqual(systemMessageOf(report('a', 3)), { kind: 'report', n: 3 })
  assert.deepEqual(systemMessageOf(peer('b')), { kind: 'message', n: 1 })
  assert.equal(systemMessageOf(user('c')), null)
  const attached = report('d')
  assert.equal(systemMessageOf({ ...attached, text: '我先说一句' } as ItemView), null)
  const answers = message('e', { event: { kind: 'manager-answers', notes: [] } })
  assert.equal(systemMessageOf(answers), null)
  const wake = message('f', { event: { kind: 'wake', notes: [] } })
  assert.deepEqual(systemMessageOf(wake), { kind: 'other', n: 1 })
  const task = message('g', {
    text: '写日报',
    system: { kind: 'scheduledTask', task: '日报', manual: false, prompt: '写日报' },
  })
  assert.deepEqual(systemMessageOf(task), { kind: 'schedule', n: 1 })
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
  assert.equal(systemMessageOf(briefing), null)
})

test('连续几条回报、中间没写正文：并成一块，消息条数、步数的条目和用时都累加', () => {
  const turns = [
    fold(turnOf('t1', [report('r1'), tool('a1')])),
    fold(turnOf('t2', [report('r2', 2), tool('a2'), tool('a3')])),
    fold(turnOf('t3', [peer('m3'), tool('a4')])),
  ]
  assert.deepEqual(runsOf(turns), [['t1', 't2', 't3']])
  const role = systemRuns(turns).get('t2')
  assert.ok(role)
  assert.equal(role.head, false)
  assert.equal(role.whole, true)
  assert.equal(systemRuns(turns).get('t1')?.head, true)
  assert.deepEqual(role.run.messages, [
    { kind: 'report', n: 3 },
    { kind: 'message', n: 1 },
  ])
  assert.deepEqual(role.run.itemIds, ['r1', 'a1', 'r2', 'a2', 'a3', 'm3', 'a4'])
  assert.equal(role.run.durationMs, 3000)
})

test('中间夹着用户自己发的消息：前后切开，用户的回合不进收起块', () => {
  const turns = [
    fold(turnOf('t1', [report('r1'), tool('a1')])),
    fold(turnOf('u', [user('u1'), tool('b1'), text('b2')])),
    fold(turnOf('t2', [report('r2'), tool('a2')])),
    fold(turnOf('t3', [report('r3'), tool('a3')])),
  ]
  assert.deepEqual(runsOf(turns), [['t1'], ['t2', 't3']])
  assert.equal(systemRuns(turns).has('u'), false)
})

test('系统回合写了正文：正文前的系统消息和过程进块，正文露在外面，后面的系统回合另起一块', () => {
  const t1 = fold(turnOf('t1', [report('r1'), tool('a1')]))
  const t2 = fold(turnOf('t2', [report('r2'), tool('a2'), text('answer2')]))
  const t3 = fold(turnOf('t3', [report('r3'), tool('a3')]))
  assert.equal(t2.whole, false)
  assert.equal(t2.lead, 2)
  assert.deepEqual(runsOf([t1, t2, t3]), [['t1', 't2'], ['t3']])
  // 整个回合只有正文（模型直接回话）：系统消息照样进块，正文在外面
  const t4 = fold(turnOf('t4', [peer('m4'), text('answer4')]))
  assert.equal(t4.lead, 1)
  assert.deepEqual(t4.itemIds, ['m4'])
})

test('阶段不明的正文（Claude 等）：领头到第一段正文为止；之后同一段过程归收起块管', () => {
  const entry = turnOf('t1', [
    report('r1'),
    tool('a1'),
    text('n1', 'unknown'),
    tool('a2'),
    text('n2', 'unknown'),
  ])
  const shape = fold(entry)
  assert.equal(shape.lead, 2)
  // 正文后面那一组工具和前面的属于同一段，一起算进标题行
  assert.deepEqual(shape.itemIds, ['r1', 'a1', 'a2'])
  const blocks = bucketItems(entry.turn.itemIds.map((id) => blockInput(id, entry.items[id]!)))
  assert.deepEqual([...governedSegments(blocks, shape.lead)], ['a1'])
})

test('正在跑、出错、被打断的系统回合照常单独画，结束后才并进前面的块', () => {
  const t1 = fold(turnOf('t1', [report('r1'), tool('a1')]))
  const running = turnOf('t2', [report('r2'), tool('a2')], 'running')
  assert.deepEqual(runsOf([t1, fold(running)]), [['t1']])
  assert.deepEqual(
    runsOf([t1, fold({ ...running, turn: { ...running.turn, status: 'completed' } })]),
    [['t1', 't2']],
  )
  const failed = fold(turnOf('t3', [report('r3'), tool('a3')], 'failed'))
  const t4 = fold(turnOf('t4', [report('r4')]))
  assert.deepEqual(runsOf([t1, failed, t4]), [['t1'], ['t4']])
  // 还有子代理没做完的也先不收
  assert.deepEqual(runsOf([t1, { ...t4, agentsRunning: true }]), [['t1']])
})

test('自发回合、跑着时插进来的回报、对用户透明的提醒回合、查找时的跳行', () => {
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
  assert.equal(completed.whole, true)
  // 自发回合开头是用户插的话：照用户消息切开
  const steeredByUser = fold(
    turnOf('bu', [user('bu-u'), tool('x3')], 'completed', { origin: 'backgroundTask' }),
  )
  assert.equal(steeredByUser.messages, null)
  // 跑着时又插进来一条回报：照样在领头里，不切开
  const steered = fold(turnOf('s', [report('r1'), tool('a1'), report('r2'), tool('a2')]))
  assert.equal(steered.whole, true)
  assert.deepEqual(steered.messages, [{ kind: 'report', n: 2 }])
  // 跑着时用户插了话：用户参与的回合，照旧单独画
  const mixed = fold(turnOf('m', [report('r3'), tool('a3'), user('u1'), tool('a4')]))
  assert.equal(mixed.messages, null)
  // 提醒收尾的回合什么都不画：不打断
  const remind = fold(turnOf('remind', [message('rm', { event: { kind: 'remind', notes: [] } })]))
  assert.equal(remind.hidden, true)
  const after = fold(turnOf('t9', [report('r9')]))
  assert.deepEqual(runsOf([background, remind, after]), [['b', 't9']])
  assert.deepEqual(runsOf([background, null, after]), [['b'], ['t9']])
})

test('开合：成员里有一个开着就开；都没开、有一个点收就收；都没点过照默认', () => {
  assert.equal(runOpen([undefined, undefined], false), false)
  assert.equal(runOpen([undefined, undefined], true), true)
  assert.equal(runOpen([false, true], false), true)
  assert.equal(runOpen([false, undefined], true), false)
})
