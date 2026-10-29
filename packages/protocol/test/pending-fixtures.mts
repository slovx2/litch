// 客户端投影和设备历史读取共用的行为矩阵；期望值独立于派生实现。
import { askQuestionId, askReplyText } from '../src/async-asks.mjs'
import { formatSessionEvent } from '../src/session-tree.mjs'

export const asyncQuestion = (id = 'a', title = '范围？') => ({
  id,
  type: 'agentMessage',
  text: '',
  phase: 'commentary',
  delivery: 'async',
  questions: [{ title, options: ['只改 src', '全部'] }],
})
export const wrapQuestion = (id = 'w', extra: Record<string, unknown> = {}, success = true) => ({
  id,
  type: 'dynamicToolCall',
  namespace: 'litch_sessions',
  tool: 'wrap_up',
  status: 'completed',
  success,
  arguments: {
    suggestions: [],
    ask: '继续？',
    actions: [{ label: '继续', message: '继续执行' }],
    ...extra,
  },
  contentItems: [],
  durationMs: 1,
})
export const message = (text: string, id = 'u') => ({
  id,
  type: 'userMessage',
  content: [{ type: 'text', text }],
})
export const turn = (id: string, items: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  items,
  status: 'completed',
  startedAt: 1700000000,
  durationMs: 1,
  error: null,
  ...extra,
})
export const reportText = formatSessionEvent({
  kind: 'wake',
  notes: [
    { threadId: 'c', title: '子任务', status: 'completed', excerpt: '完成' },
    { threadId: 'd', title: '子任务二', status: 'completed', excerpt: '完成' },
  ],
})
export interface PendingFixture {
  name: string
  turns: unknown[]
  titles: string[]
  queued?: { text: string }[]
  reports?: number
}
const first = turn('t1', [asyncQuestion(), wrapQuestion()])
const reply = askReplyText([
  { questionItemId: askQuestionId('a', 0), question: '范围？', answer: '只改 src' },
])
export const pendingFixtures: PendingFixture[] = [
  { name: '两类问题及原始选项', turns: [first], titles: ['范围？', '继续？'] },
  {
    name: '唤醒不消题并计实际回报条数',
    turns: [first, turn('t2', [message(reportText)])],
    titles: ['范围？', '继续？'],
    reports: 2,
  },
  {
    name: '成功撤回',
    turns: [first, turn('t2', [wrapQuestion('w2', { ask: '', withdraw_questions: ['继续？'] })])],
    titles: ['范围？'],
  },
  {
    name: '失败撤回无效',
    turns: [
      first,
      turn('t2', [wrapQuestion('w2', { ask: '', withdraw_questions: ['继续？'] }, false)]),
    ],
    titles: ['范围？', '继续？'],
  },
  {
    name: '未完成撤回无效',
    turns: [
      first,
      turn('t2', [
        {
          ...wrapQuestion('w2', { ask: '', withdraw_questions: ['继续？'] }),
          status: 'inProgress',
        },
      ]),
    ],
    titles: ['范围？', '继续？'],
  },
  { name: '真正用户输入清空', turns: [first, turn('t2', [message('用户改变方向')])], titles: [] },
  { name: '空输入保留', turns: [first, turn('t2', [message(' ')])], titles: ['范围？', '继续？'] },
  {
    name: '原生自动回合保留',
    turns: [first, turn('t2', [message('继续')], { litchOrigin: 'backgroundTask' })],
    titles: ['范围？', '继续？'],
  },
  {
    name: '自动回合中用户插话清空',
    turns: [
      first,
      turn('t2', [message('自动'), message('用户改向', 'u2')], { litchOrigin: 'backgroundTask' }),
    ],
    titles: [],
  },
  {
    name: '会话间消息保留',
    turns: [
      first,
      turn('t2', [{ ...message('同意'), litchPeer: { name: '同伴', thread: 'other' } }]),
    ],
    titles: ['范围？', '继续？'],
  },
  {
    name: '同题合并',
    turns: [first, turn('t2', [asyncQuestion('a2'), wrapQuestion('w2')])],
    titles: ['范围？', '继续？'],
  },
  { name: '显式答复只消对应题', turns: [first, turn('t2', [message(reply)])], titles: ['继续？'] },
  { name: '排队答复只消对应题', turns: [first], queued: [{ text: reply }], titles: ['继续？'] },
  {
    name: '收尾题回合结束才显示',
    turns: [turn('t1', [asyncQuestion(), wrapQuestion()], { status: 'inProgress' })],
    titles: ['范围？'],
  },
]
