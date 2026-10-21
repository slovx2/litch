// 建议任务（src/detail/proposals/logic.ts、src/core/rows.ts 里的提案行和会话事件行）：哪条调用画成几张卡、
// 没带建议的收尾不画也不拆开过程组、提醒画成提示不画成用户消息、列表的排法、“改了再开始”只发改过的；
// offer 卡（“新会话 / 在这里做”）按 callId 对上、交接（hand_off）画成单独一行；
// 接在模拟核心上：说“提个子会话”出三张卡，点“不要”之后那张的状态跟着变；文案键。
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { zhCN as desktop } from '../../../packages/ui/src/i18n/zh-CN.ts'
import { fieldsFor } from '../../../packages/ui/src/tree/spawn-form.ts'
import { RowBuilder } from '../src/core/rows.ts'
import { SessionStore } from '../src/core/session-store.ts'
import {
  arrange,
  cardsOf,
  eventKind,
  handOffOf,
  isLongBrief,
  isOfferCall,
  nextExpiry,
  overridesFor,
  pendingCount,
  STATUS_TEXT,
} from '../src/detail/proposals/logic.ts'
import * as messages from '../src/ui/messages/proposals.ts'
import { mockChannel, until } from './helpers.mjs'

const cleanup = []
afterEach(() => {
  for (const done of cleanup.splice(0)) done()
})

const NOW = 1_000_000
const proposal = (id, extra = {}) => ({
  id,
  title: `任务 ${id}`,
  prompt: `简报 ${id}`,
  background: `背景 ${id}`,
  harness: null,
  model: null,
  cwd: null,
  kind: 'fresh',
  wakeParent: true,
  status: 'pending',
  createdAt: NOW - 1000,
  expiresAt: NOW + 60_000,
  settledAt: null,
  startedId: null,
  turnId: 't',
  callId: null,
  widerSandbox: null,
  ...extra,
})
const call = (id, tool, extra = {}) => ({
  id,
  kind: 'toolCall',
  source: 'litch_sessions',
  tool,
  input: [],
  output: [],
  error: null,
  durationMs: 5,
  status: 'completed',
  ...extra,
})
const command = (id) => ({
  id,
  kind: 'command',
  command: `run ${id}`,
  cwd: '/w',
  output: '',
  elided: null,
  exitCode: 0,
  durationMs: 3,
  startedAt: null,
  status: 'completed',
})
const user = (id, text, event) => ({
  id,
  kind: 'userMessage',
  text,
  attachments: [],
  ...(event ? { event } : {}),
})
const viewOf = (itemIds, items, proposals = []) => ({
  forkedFrom: null,
  proposals,
  requests: [],
  turns: [{ id: 't', status: 'completed', itemIds, startedAt: null, durationMs: 10, error: null }],
  items: Object.fromEntries(items.map((item) => [item.id, item])),
})
const types = (rows) => rows.map((row) => row.type)

test('哪条调用画成几张卡：收尾按 callId 对上几张；start 按提案号，列表里还没有时照调用画；别的照常', () => {
  const list = [
    proposal('p1', { callId: 'w' }),
    proposal('p2', { callId: 'w' }),
    proposal('p3', { callId: 's' }),
  ]
  assert.deepEqual(
    cardsOf(call('w', 'wrap_up'), list).map((entry) => entry.id),
    ['p1', 'p2'],
  )
  assert.deepEqual(cardsOf(call('w2', 'wrap_up'), list), [], '没带建议的收尾：不画')
  // 真设备上条目键是“回合号:条目号”，提案记的是协议里的条目号
  assert.deepEqual(
    cardsOf(call('t1:w', 'wrap_up'), list).map((entry) => entry.id),
    ['p1', 'p2'],
  )
  const spawned = { proposalId: 'p9', threadId: null, title: 'x', prompt: 'y' }
  assert.deepEqual(cardsOf(call('s9', 'start', { spawned }), list), [null])
  assert.equal(
    cardsOf(call('s', 'start', { spawned: { ...spawned, proposalId: 'p3' } }), list)[0].id,
    'p3',
  )
  // 直接起了子会话的 start（没有哪张提案记着它）、别的工具：不是提案卡
  assert.equal(
    cardsOf(call('s0', 'start', { spawned: { ...spawned, proposalId: null } }), list),
    null,
  )
  assert.equal(cardsOf(call('r', 'read'), list), null)
  assert.equal(cardsOf({ ...call('w', 'wrap_up'), source: 'other' }, list), null)
})

test('对话里的行：收尾的每条建议一张卡、排在过程组后面；没带建议的收尾不画，也不把过程组拆成两段', () => {
  const items = [user('u', '做吧'), command('c1'), call('w0', 'wrap_up'), command('c2')]
  const empty = new RowBuilder().build(viewOf(['u', 'c1', 'w0', 'c2'], items), 'all')
  assert.deepEqual(types(empty), ['user', 'group', 'status'])
  assert.equal(empty[1].count, 2)

  const list = [proposal('p1', { callId: 'w' }), proposal('p2', { callId: 'w' })]
  const rows = new RowBuilder().build(
    viewOf(['u', 'c1', 'w'], [user('u', '做吧'), command('c1'), call('w', 'wrap_up')], list),
    'all',
  )
  assert.deepEqual(types(rows), ['user', 'group', 'proposal', 'proposal', 'status'])
  assert.deepEqual(
    rows.filter((row) => row.type === 'proposal').map((row) => row.key),
    ['w:p1', 'w:p2'],
  )
})

test('收尾区：带建议、留了问题的收尾在过程里只留一步，问题和卡片排到回答下面', () => {
  const answer = { id: 'a', kind: 'agentMessage', text: '做完了', status: 'completed' }
  const wrapUp = {
    summary: null,
    suggestions: [{ title: '任务 p1' }],
    ask: '接着做哪个？',
    actions: [{ label: '先修测试', message: '先把测试修了' }, { label: '不用了' }],
  }
  const list = [proposal('p1', { callId: 'w' })]
  const rows = new RowBuilder().build(
    viewOf(
      ['u', 'c1', 'w', 'a'],
      [user('u', '做吧'), command('c1'), call('w', 'wrap_up', { wrapUp }), answer],
      list,
    ),
    'all',
  )
  assert.deepEqual(types(rows), ['user', 'group', 'md', 'wrapAsk', 'proposal', 'status'])
  assert.equal(rows[1].count, 2, '收尾那一步留在过程里')
  const ask = rows.find((row) => row.type === 'wrapAsk')
  assert.equal(ask.ask, '接着做哪个？')
  assert.deepEqual(
    ask.actions.map((action) => action.label),
    ['先修测试', '不用了'],
  )
  // 只留了问题、没带建议：问题照样排到最下面
  const askOnly = new RowBuilder().build(
    viewOf(
      ['u', 'w2', 'a'],
      [
        user('u', '做吧'),
        call('w2', 'wrap_up', { wrapUp: { ...wrapUp, suggestions: [] } }),
        answer,
      ],
    ),
    'all',
  )
  assert.deepEqual(types(askOnly), ['user', 'group', 'md', 'wrapAsk', 'status'])
})

const json = (value) => [{ kind: 'text', text: JSON.stringify(value, null, 2) }]
const offerCall = (id, extra = {}) =>
  call(id, 'start', {
    input: json({ title: '整理发布说明', initiation: 'offer' }),
    spawned: { proposalId: null, threadId: null, title: '整理发布说明', prompt: '', kind: 'fresh' },
    status: 'inProgress',
    output: [],
    ...extra,
  })

test('offer 卡：调用还在等时按 callId 对上提案，提案还没到也先画一张；别的 start 照旧', () => {
  assert.equal(isOfferCall(offerCall('o')), true)
  assert.equal(
    isOfferCall(call('s', 'start', { input: json({ title: 'x', prompt: 'y' }), spawned: {} })),
    false,
  )
  // 不是 start 的调用里写了 initiation 也不算
  assert.equal(isOfferCall(call('r', 'read', { input: json({ initiation: 'offer' }) })), false)
  const list = [proposal('p1', { callId: 'o', status: 'offered', prompt: '' })]
  assert.equal(cardsOf(offerCall('o'), list)[0].id, 'p1')
  assert.deepEqual(cardsOf(offerCall('o2'), list), [null], '提案还没到：先画一张')
  // 选了之后调用有了结果（带提案号）：照提案号对上
  const answered = offerCall('o', {
    status: 'completed',
    spawned: { ...offerCall('o').spawned, proposalId: 'p1' },
  })
  assert.equal(cardsOf(answered, list)[0].id, 'p1')
  // 降成提案的 start 结果还没来、提案已经到了：按 callId 先画；直接起了的（没有提案）不是卡
  const propose = call('s', 'start', { spawned: { proposalId: null, threadId: null }, input: [] })
  assert.equal(cardsOf(propose, [proposal('p2', { callId: 's' })])[0].id, 'p2')
  assert.equal(cardsOf(propose, list), null)

  const rows = new RowBuilder().build(
    viewOf(['u', 'o'], [user('u', '另外，帮我整理发布说明'), offerCall('o')], list),
    'all',
  )
  assert.deepEqual(types(rows), ['user', 'proposal', 'status'])
  assert.equal(rows[1].offer, true)
  assert.equal(rows[1].proposal.id, 'p1')
})

test('交接：画成单独一行（标题、分叉会话），不进过程组；失败的照普通工具调用画', () => {
  const handOff = (id, extra = {}) =>
    call(id, 'hand_off', {
      input: json({ title: '把 lint 修完', remaining_plan: '剩下三个文件……' }),
      output: json({ thread_id: 'th-fork', note: 'started' }),
      ...extra,
    })
  assert.deepEqual(handOffOf(handOff('h')), { title: '把 lint 修完', threadId: 'th-fork' })
  assert.deepEqual(handOffOf(handOff('h', { status: 'inProgress', output: [] })), {
    title: '把 lint 修完',
    threadId: null,
  })
  assert.equal(handOffOf(handOff('h', { status: 'failed', error: [] })), null)
  assert.equal(handOffOf(call('r', 'read')), null)
  // 参数太长被截过（不是完整的 JSON）也认得出标题
  const cut = [
    { kind: 'text', text: '{\n  "title": "长任务 \\"引号\\"",\n  "remaining_plan": "一二三' },
    { kind: 'gap', chars: 9000, bytes: 9000, parts: 1 },
  ]
  assert.equal(handOffOf(handOff('h', { input: cut })).title, '长任务 "引号"')

  const items = [user('u', '先别做了，看看这个'), command('c1'), handOff('h'), command('c2')]
  const rows = new RowBuilder().build(viewOf(['u', 'c1', 'h', 'c2'], items), 'all')
  assert.deepEqual(types(rows), ['user', 'group', 'handoff', 'group', 'status'])
  assert.equal(rows[2].threadId, 'th-fork')
  assert.equal(rows[2].running, false)
  const failed = new RowBuilder().build(
    viewOf(['u', 'h'], [user('u', 'x'), handOff('h', { status: 'failed', error: [] })]),
    'all',
  )
  assert.equal(types(failed).includes('handoff'), false)
})

test('注入的会话事件：提醒、唤醒只画提示不画用户消息；回报加上用户自己的话两样都画', () => {
  const remind = { kind: 'remind', notes: [] }
  const notes = {
    kind: 'notes',
    notes: [{ threadId: 'c', title: '子', status: 'completed', excerpt: '好了' }],
  }
  assert.equal(eventKind(remind), 'remind')
  assert.equal(eventKind({ kind: 'wake', notes: notes.notes }), 'wake')
  assert.equal(eventKind(notes), 'notes')
  const only = new RowBuilder().build(viewOf(['u'], [user('u', '', remind)]), 'all')
  assert.deepEqual(types(only), ['event', 'status'])
  assert.equal(only[0].kind, 'remind')
  // 提醒回合里模型顺口说的话不画
  const said = {
    id: 'a',
    kind: 'agentMessage',
    text: '好的。',
    status: 'completed',
    phase: 'final',
  }
  const acked = new RowBuilder().build(viewOf(['u', 'a'], [user('u', '', remind), said]), 'all')
  assert.deepEqual(types(acked), ['event', 'status'])
  const both = new RowBuilder().build(viewOf(['u'], [user('u', '接着做', notes)]), 'all')
  assert.deepEqual(types(both), ['event', 'user', 'status'])
  assert.equal(both[0].notes[0].excerpt, '好了')
})

test('列表的排法：等着的在上（先提的在前），了结的在下（刚了结的在前）；过期了的不算等着', () => {
  const list = [
    proposal('a', { createdAt: 1 }),
    proposal('b', { status: 'dismissed', settledAt: NOW - 500 }),
    proposal('c', { createdAt: 2, expiresAt: NOW - 1 }),
    proposal('d', { status: 'started', settledAt: NOW - 100, startedId: 'x' }),
    proposal('e', { createdAt: 3, expiresAt: NOW + 5000 }),
  ]
  const { pending, settled } = arrange(list, NOW)
  assert.deepEqual(
    pending.map((entry) => entry.id),
    ['a', 'e'],
  )
  assert.deepEqual(
    settled.map((entry) => entry.id),
    ['c', 'd', 'b'],
  )
  assert.equal(pendingCount(list, NOW), 2)
  assert.equal(nextExpiry(list, NOW), NOW + 5000)
  assert.equal(nextExpiry([], NOW), null)
})

test('列表里的 offer：等你选、等模型补简报的在上；在这里做的算了结；角标只数等用户动手的', () => {
  const list = [
    proposal('a', { createdAt: 1 }),
    proposal('o', { createdAt: 2, status: 'offered', prompt: '' }),
    proposal('ch', { createdAt: 3, status: 'chosen', prompt: '' }),
    proposal('h', { status: 'here', settledAt: NOW - 10, prompt: '' }),
    proposal('d', { status: 'dismissed', settledAt: NOW - 500 }),
  ]
  const { pending, settled } = arrange(list, NOW)
  assert.deepEqual(
    pending.map((entry) => entry.id),
    ['a', 'o', 'ch'],
  )
  assert.deepEqual(
    settled.map((entry) => entry.id),
    ['h', 'd'],
  )
  assert.equal(pendingCount(list, NOW), 2)
})

test('改了再开始：什么都没改是空的；改了唤醒、标题、简报、换了 harness 只带这几项', () => {
  const parent = { harness: 'claude-code', workspaceId: null }
  const base = proposal('p', { model: 'opus', wakeParent: true })
  const fields = fieldsFor(parent, base)
  assert.deepEqual(overridesFor(fields, parent, base), {})
  assert.deepEqual(overridesFor({ ...fields, wake: false }, parent, base), { wakeParent: false })
  assert.deepEqual(
    overridesFor({ ...fields, title: ' 新标题 ', prompt: `${base.prompt}  ` }, parent, base),
    { title: '新标题' },
  )
  // 换了 harness 又没另选模型：提案原来的模型清掉；带上下文只能同 harness，变成全新
  assert.deepEqual(
    overridesFor({ ...fields, harness: 'pi', model: '', kind: 'fork' }, parent, base),
    { harness: 'pi', model: '' },
  )
})

test('简报长了才折：超过 160 字或者超过 3 行', () => {
  assert.equal(isLongBrief('短'), false)
  assert.equal(isLongBrief('字'.repeat(161)), true)
  assert.equal(isLongBrief('一\n二\n三\n四'), true)
})

test('接在模拟核心上：说“提个子会话”出三张卡；点“不要”那张变成不要了，回合不用重开', async () => {
  const mock = mockChannel()
  const { sessionId } = await mock.channel.command('session.create', {
    deviceId: 'local',
    cwd: null,
    text: '提个子会话',
  })
  const store = new SessionStore(mock.channel, 'local', sessionId)
  cleanup.push(() => {
    store.stop()
    mock.close()
  })
  store.start()
  const cardsNow = () => store.getSnapshot().rows.filter((row) => row.type === 'proposal')
  const cards = await until(
    () => (cardsNow().length === 3 && cardsNow().every((row) => row.proposal) ? cardsNow() : null),
    { what: '三张提案卡' },
  )
  // 列表页、“改了再开始”从会话存储取提案（手机上数据副本不开会话）
  assert.equal(store.getProposals()?.length, 3)
  const target = cards.find((row) => row.proposal.status === 'pending')
  await mock.channel.command('session.proposal.dismiss', {
    deviceId: 'local',
    sessionId,
    proposalId: target.proposal.id,
  })
  await until(
    () =>
      cardsNow().find((row) => row.proposal?.id === target.proposal.id)?.proposal.status ===
      'dismissed',
    { what: '那张变成不要了' },
  )
  assert.equal(
    store.getProposals().find((entry) => entry.id === target.proposal.id).status,
    'dismissed',
  )
})

test('文案：中英文的键一样多；没有和桌面界面撞名的键；每种状态都有字', () => {
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages.zhCN).sort())
  for (const key of Object.values(STATUS_TEXT))
    assert.ok(key in desktop || key in messages.zhCN, `${key} 没有文案`)
  assert.deepEqual(
    Object.keys(messages.zhCN).filter((key) => key in desktop),
    [],
  )
})
