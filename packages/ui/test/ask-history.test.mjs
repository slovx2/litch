import assert from 'node:assert/strict'
import { test } from 'node:test'
import { translate } from '../src/i18n/index.ts'
import { historyQuestions, questionHistorySummary } from '../src/transcript/ask-history.ts'

const first = { id: 'first', title: '要运行测试吗？', options: ['运行'] }
const second = { id: 'second', title: '结果保存在哪里？', options: [] }
const questions = [first, second]

test('经理处理记录的收起摘要有动作和正文，用户重新回答后优先显示用户答案', () => {
  const records = [
    { replyIds: ['first'], action: 'answer', text: '运行单测' },
    { replyIds: ['second'], action: 'withdraw', text: '不再需要保存' },
  ]
  for (const [lang, expected] of [
    ['zh-CN', '经理已代答: 运行单测 · 经理已撤回: 不再需要保存'],
    ['en', 'Manager answered: 运行单测 · Manager withdrew: 不再需要保存'],
  ]) {
    const label = (action) => translate(lang, `ask.manager.${action}`)
    assert.equal(questionHistorySummary(questions, {}, records, label), expected)
    assert.equal(
      questionHistorySummary([first], { first: '用户要求全量测试' }, records, label),
      '用户要求全量测试',
    )
    assert.equal(records[0].text, '运行单测', '覆盖答复不抹去经理记录')
  }
})

test('待答时对话流不显示；作答后同一问题进入记录，不再重复', () => {
  assert.deepEqual(historyQuestions(questions, [{ replyIds: ['first', 'second'] }]), [])
  assert.deepEqual(historyQuestions(questions, []), questions)
})

test('多题部分回答：已答题进入记录，未答题只留在待答区', () => {
  assert.deepEqual(historyQuestions(questions, [{ replyIds: ['second'] }]), [first])
})

test('忽略、撤回或普通消息关闭后留下记录；重连只由当前待答集合决定', () => {
  const snapshot = structuredClone(questions)
  assert.deepEqual(historyQuestions(snapshot, []), questions)
  assert.deepEqual(historyQuestions(snapshot, [{ replyIds: ['first'] }]), [second])
})

test('合并的重复提问按所有来源标识隐藏，同题的新提问不隐藏旧记录', () => {
  const repeated = { ...first, id: 'repeat' }
  assert.deepEqual(historyQuestions([first, repeated], [{ replyIds: ['first', 'repeat'] }]), [])
  assert.deepEqual(historyQuestions([first, repeated], [{ replyIds: ['repeat'] }]), [first])
})
