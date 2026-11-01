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
    '3 decisions · 1 For you request',
  )
  assert.equal(
    translate('en', 'manager.pendingDetail', { decisions: 1, requests: 2 }),
    '1 decision · 2 For you requests',
  )
  assert.equal(translate('zh-CN', 'manager.open'), '待定')
})
