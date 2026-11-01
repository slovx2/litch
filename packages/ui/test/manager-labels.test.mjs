import assert from 'node:assert/strict'
import test from 'node:test'
import { translate } from '../src/i18n/index.ts'

test('经理草稿提示在零、一、多项时采用正确英文复数', () => {
  for (const key of ['manager.unsent', 'manager.draftCount']) {
    assert.equal(translate('en', key, { n: 0 }), '0 drafts')
    assert.equal(translate('en', key, { n: 1 }), '1 draft')
    assert.equal(translate('en', key, { n: 2 }), '2 drafts')
  }
})

test('待处理合计与悬停明细区分决策、请你做，决策筛选仍叫待定', () => {
  assert.equal(translate('zh-CN', 'manager.pending', { n: 4 }), '4 待处理')
  assert.equal(translate('en', 'manager.pending', { n: 4 }), '4 to handle')
  assert.equal(
    translate('zh-CN', 'manager.pendingDetail', { decisions: 3, requests: 1 }),
    '3 个决策 · 1 个请你做',
  )
  assert.equal(
    translate('en', 'manager.pendingDetail', { decisions: 3, requests: 1 }),
    '3 decisions · 1 request for you',
  )
  assert.equal(
    translate('en', 'manager.pendingDetail', { decisions: 1, requests: 2 }),
    '1 decision · 2 requests for you',
  )
  assert.equal(translate('zh-CN', 'manager.open'), '待定')
})

test('待处理悬停明细省略零项，没有多余分隔符', () => {
  for (const [decisions, requests, en, zh] of [
    [0, 0, '', ''],
    [1, 0, '1 decision', '1 个决策'],
    [2, 0, '2 decisions', '2 个决策'],
    [0, 1, '1 request for you', '1 个请你做'],
    [0, 2, '2 requests for you', '2 个请你做'],
  ]) {
    assert.equal(translate('en', 'manager.pendingDetail', { decisions, requests }), en)
    assert.equal(translate('zh-CN', 'manager.pendingDetail', { decisions, requests }), zh)
  }
})

test('待答问题、工作线与侧栏未读计数的英文单复数', () => {
  for (const [n, question, lines, unread] of [
    [0, '0 questions awaiting answers', '0 work lines running', '0 unread conversations'],
    [1, '1 question awaiting an answer', '1 work line running', '1 unread conversation'],
    [2, '2 questions awaiting answers', '2 work lines running', '2 unread conversations'],
  ]) {
    assert.equal(translate('en', 'ask.pendingCount', { count: n }), question)
    assert.equal(translate('en', 'manager.linesCount', { n }), lines)
    assert.equal(translate('en', 'sidebar.projection.count', { n }), unread)
  }
})

test('D-29：悬停明细含已审建议，不含报告未读', () => {
  const counts = { decisions: 3, requests: 1, suggestions: 2, reports: 9 }
  assert.equal(
    translate('zh-CN', 'manager.pendingDetail', counts),
    '3 个决策 · 1 个请你做 · 2 条建议',
  )
  assert.equal(
    translate('en', 'manager.pendingDetail', counts),
    '3 decisions · 1 request for you · 2 suggestions',
  )
  assert.equal(translate('en', 'manager.pendingDetail', { reports: 9 }), '')
})
