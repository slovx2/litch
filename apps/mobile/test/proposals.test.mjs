// 建议任务（src/detail/proposals/logic.ts、src/core/rows.ts 里的提案行和会话事件行）：哪条调用画成几张卡、
// 没带建议的收尾不画也不拆开过程组、提醒画成提示不画成用户消息、列表的排法、“改了再开始”只发改过的；
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
  isLongBrief,
  nextExpiry,
  overridesFor,
  pendingCount,
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
  const spawned = { proposalId: 'p9', threadId: null, title: 'x', prompt: 'y' }
  assert.deepEqual(cardsOf(call('s9', 'start', { spawned }), list), [null])
  assert.equal(
    cardsOf(call('s', 'start', { spawned: { ...spawned, proposalId: 'p3' } }), list)[0].id,
    'p3',
  )
  // 直接起了子会话的 start、别的工具：不是提案卡
  assert.equal(
    cardsOf(call('s', 'start', { spawned: { ...spawned, proposalId: null } }), list),
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

test('注入的会话事件：提醒、唤醒只画提示不画用户消息；回报加上用户自己的话两样都画', () => {
  const remind = { kind: 'notes', notes: [] }
  const notes = {
    kind: 'notes',
    notes: [{ threadId: 'c', title: '子', status: 'completed', excerpt: '好了' }],
  }
  assert.equal(eventKind(remind), 'remind')
  assert.equal(eventKind({ kind: 'remind', notes: [] }), 'remind')
  assert.equal(eventKind({ kind: 'wake', notes: notes.notes }), 'wake')
  assert.equal(eventKind(notes), 'notes')
  const only = new RowBuilder().build(viewOf(['u'], [user('u', '', remind)]), 'all')
  assert.deepEqual(types(only), ['event', 'status'])
  assert.equal(only[0].kind, 'remind')
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

test('文案：中英文的键一样多；没有和桌面界面撞名的键', () => {
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages.zhCN).sort())
  assert.deepEqual(
    Object.keys(messages.zhCN).filter((key) => key in desktop),
    [],
  )
})
