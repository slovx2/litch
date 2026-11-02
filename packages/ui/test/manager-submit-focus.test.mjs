import assert from 'node:assert/strict'
import test from 'node:test'
import {
  focusDecisionAfterSubmit,
  nextPendingDecision,
} from '../src/manager/decision-submit-focus.ts'

test('待定栏答复一条后接续下一条待定，遵循当前显示顺序', () => {
  assert.equal(nextPendingDecision(['D-3', 'D-2', 'D-1'], ['D-3'], ['D-2', 'D-1']), 'D-2')
  assert.equal(nextPendingDecision(['D-1', 'D-2', 'D-3'], ['D-1'], ['D-2', 'D-3']), 'D-2')
})

test('批量答复跳过成功项，部分失败与别处结束的决策按剩余状态接续', () => {
  const before = ['D-4', 'D-3', 'D-2', 'D-1']
  assert.equal(nextPendingDecision(before, ['D-4', 'D-3'], ['D-2', 'D-1']), 'D-2')
  assert.equal(nextPendingDecision(before, ['D-4', 'D-2'], ['D-3', 'D-1']), 'D-3')
  assert.equal(nextPendingDecision(before, ['D-4'], ['D-1']), 'D-1')
})

test('末条或整批答复后没有下一条就回列表头，不绕到之前的决策', () => {
  assert.equal(nextPendingDecision(['D-2', 'D-1'], ['D-1'], ['D-2']), null)
  assert.equal(nextPendingDecision(['D-2', 'D-1'], ['D-2', 'D-1'], []), null)
  assert.equal(nextPendingDecision(['D-2', 'D-1'], [], ['D-2', 'D-1']), null)
})

test('焦点交接禁止浏览器自动滚动，只将目标移入当前可视范围', () => {
  const calls = []
  focusDecisionAfterSubmit({
    focus: (options) => calls.push(['focus', options]),
    querySelector: () => null,
    scrollIntoView: (options) => calls.push(['scroll', options]),
  })
  assert.deepEqual(calls, [
    ['focus', { preventScroll: true }],
    ['scroll', { block: 'nearest', inline: 'nearest', behavior: 'instant' }],
  ])
})

test('长卡片只滚动到标题，不停在卡片中段', () => {
  const calls = []
  focusDecisionAfterSubmit({
    focus: () => calls.push('card'),
    querySelector: (selector) => {
      assert.equal(selector, 'header')
      return { scrollIntoView: () => calls.push('heading') }
    },
    scrollIntoView: () => assert.fail('不滚动整张长卡片'),
  })
  assert.deepEqual(calls, ['card', 'heading'])
})
