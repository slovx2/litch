import assert from 'node:assert/strict'
import test from 'node:test'
import { answeredDrafts, cancelAnswerEdit, questionDrafts } from '../src/manager/drafts.ts'
import { advancePostDrafts } from '../src/manager/post-drafts.ts'
import { boardReferences } from '../src/manager/references.ts'
import { submittedRequests } from '../src/manager/request-drafts.ts'

test('同一决策可同时存答案与追问，独立提取提交字段且忽略空白草稿', () => {
  const drafts = {
    'D-1': { decisionId: 'D-1', revision: 4, optionId: 'yes', text: '同意', question: '依据？' },
    'D-2': { decisionId: 'D-2', revision: 2, optionId: null, text: '', question: '还有影响吗？' },
    'D-3': { decisionId: 'D-3', revision: 1, optionId: null, text: ' ', question: ' ' },
  }
  assert.deepEqual(answeredDrafts(drafts), [
    { decisionId: 'D-1', revision: 4, optionId: 'yes', text: '同意' },
  ])
  assert.deepEqual(
    questionDrafts(drafts).map((entry) => entry.decisionId),
    ['D-1', 'D-2'],
  )
})
test('请你做允许仅交付、仅文字及带备注；编号可混合跳转', () => {
  const drafts = {
    'R-1': { requestId: 'R-1', revision: 1, delivered: true, text: '' },
    'R-2': { requestId: 'R-2', revision: 1, delivered: false, text: '做不了' },
    'R-3': { requestId: 'R-3', revision: 1, delivered: false, text: ' ' },
  }
  assert.deepEqual(
    submittedRequests(drafts).map((entry) => entry.requestId),
    ['R-1', 'R-2'],
  )
  assert.deepEqual(
    boardReferences('I-1 / R-2 / D-3 / R-99', new Set(['I-1', 'R-2', 'D-3']))
      .filter((part) => part.id)
      .map((part) => part.id),
    ['I-1', 'R-2', 'D-3'],
  )
})

test('取消答案修改保留同一决策追问与其他草稿，不修改原对象', () => {
  const drafts = {
    'D-1': { decisionId: 'D-1', revision: 4, optionId: 'yes', text: '修改', question: '依据？' },
    'D-2': { decisionId: 'D-2', revision: 2, optionId: null, text: '继续', question: '' },
  }
  const next = cancelAnswerEdit(drafts, 'D-1')
  assert.deepEqual(answeredDrafts(next), [
    { decisionId: 'D-2', revision: 2, optionId: null, text: '继续' },
  ])
  assert.equal(questionDrafts(next)[0].question, '依据？')
  assert.equal(drafts['D-1'].text, '修改')
  assert.deepEqual(Object.keys(cancelAnswerEdit(next, 'D-2')), ['D-1'])
})

test('交付与同帖追问混合提交：只推进已成功对象版本，失败项保留原草稿', () => {
  const drafts = {
    'R-1': { id: 'R-1', revision: 1, question: '交付后还要验证吗' },
    'P-1': { id: 'P-1', revision: 2, question: '范围' },
  }
  const next = advancePostDrafts(drafts, [{ id: 'R-1', revision: 2 }])
  assert.equal(next['R-1'].revision, 2)
  assert.equal(next['R-1'].question, drafts['R-1'].question)
  assert.equal(next['P-1'], drafts['P-1'])
  assert.equal(drafts['R-1'].revision, 1)
})
