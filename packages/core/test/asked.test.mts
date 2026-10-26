// 问用户的工具（Claude 的 AskUserQuestion、OpenCode 的 question、dsh 的 ask_user_question）答完以后的问答卡片：
// 题目和回答从动态工具条目里认出来（选中的选项、自己写的、没答的），对不上的留原文；分块时露在过程外面。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { answerParts, askedOf } from '../src/projection/asked.mjs'
import { cardPlace } from '../src/projection/blocks.mjs'
import { projectItem } from '../src/projection/items.mjs'

const questions = [
  {
    id: 'q0',
    header: '范围',
    question: '装在哪一级？',
    isOther: true,
    isSecret: false,
    options: [
      { label: '用户级', description: '只给自己' },
      { label: '系统级', description: '' },
    ],
  },
  {
    id: 'q1',
    header: '功能',
    question: '要开哪些功能？',
    isOther: true,
    isSecret: false,
    options: [
      { label: '同步', description: '' },
      { label: '导入, 导出', description: '' },
    ],
  },
  { id: 'q2', header: '补充', question: '还有吗？', isOther: true, isSecret: false, options: null },
]
const lines = (...texts: string[]) => texts.map((text) => ({ type: 'inputText', text }))

test('ASKED-001：每题一行“题头: 回答”认成选中的选项、自己写的、没答的；多选里带逗号的选项拆得回来', () => {
  const asked = askedOf(
    'claude',
    'AskUserQuestion',
    { questions },
    lines('范围: 系统级', '功能: 同步, "导入, 导出", 再加一个', '补充: (no answer)'),
  )
  assert.ok(asked)
  assert.equal(asked.raw, null)
  assert.deepEqual(
    asked.questions.map(({ header, answer, picked, other }) => ({ header, answer, picked, other })),
    [
      { header: '范围', answer: '系统级', picked: [1], other: null },
      { header: '功能', answer: '同步, "导入, 导出", 再加一个', picked: [0, 1], other: '再加一个' },
      { header: '补充', answer: null, picked: [], other: null },
    ],
  )
  assert.deepEqual(asked.questions[0]?.options, questions[0]?.options)
  assert.deepEqual(asked.questions[2]?.options, [])
  // 自己写的一句话里有逗号、一项都对不上选项：整段是自己写的
  const own = askedOf(
    'opencode',
    'question',
    { questions },
    lines('范围: 都行, 你定', '功能: 同步', '补充: 好'),
  )
  assert.equal(own?.questions[0]?.other, '都行, 你定')
  assert.deepEqual(own?.questions[0]?.picked, [])
  assert.deepEqual(answerParts('"带 \\"引号\\" 的", 同步'), ['带 "引号" 的', '同步'])
  assert.deepEqual(answerParts('"没配对, 同步'), ['"没配对, 同步'])
})

test('ASKED-002：还在问的没有回答；结果对不上题目（报错、认不出）的留原文；别的工具不认', () => {
  const open = askedOf('dsh', 'ask_user_question', { questions }, null)
  assert.equal(open?.raw, null)
  assert.ok(open?.questions.every((question) => question.answer === null))
  const raw = askedOf('claude', 'AskUserQuestion', { questions }, lines('用户没有回答'))
  assert.equal(raw?.raw, '用户没有回答')
  assert.ok(raw?.questions.every((question) => question.answer === null))
  // 行数对上了但题头不对：也当认不出来
  const wrong = askedOf('claude', 'AskUserQuestion', { questions }, lines('a: 1', 'b: 2', 'c: 3'))
  assert.equal(wrong?.raw, 'a: 1\nb: 2\nc: 3')
  assert.equal(askedOf('claude', 'Bash', { questions }, null), null)
  assert.equal(askedOf('litch_sessions', 'AskUserQuestion', { questions }, null), null)
  assert.equal(askedOf('claude', 'AskUserQuestion', { questions: [] }, null), null)
})

test('ASKED-003：投影出来的工具条目带着问答，画成露在过程外面的卡片', () => {
  const item = projectItem({
    type: 'dynamicToolCall',
    id: 'ask1',
    namespace: 'claude',
    tool: 'AskUserQuestion',
    arguments: { questions },
    status: 'completed',
    contentItems: lines('范围: 用户级', '功能: (no answer)', '补充: 不用了'),
    success: true,
    durationMs: 10,
  } as never)
  assert.equal(item.kind, 'toolCall')
  assert.equal(item.kind === 'toolCall' && item.asked?.questions[2]?.other, '不用了')
  assert.equal(cardPlace(item), 'outside')
})
