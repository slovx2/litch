import assert from 'node:assert/strict'
import { test } from 'node:test'
import { historyQuestions } from '../src/transcript/ask-history.ts'

const first = { id: 'first', title: '要运行测试吗？', options: ['运行'] }
const second = { id: 'second', title: '结果保存在哪里？', options: [] }
const questions = [first, second]

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
