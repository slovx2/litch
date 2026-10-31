// 首批固定，恢复旧位置也分批补齐，不随锚点距离扩大一次提交的内容。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { FIRST_TURNS, MORE_TURNS, restoreWindow, growWindow } = await import(
  '../src/transcript/turn-window.ts'
)

test('恢复锚点需要补齐的范围，包含前面一个回合', () => {
  assert.equal(restoreWindow(null), FIRST_TURNS)
  assert.equal(restoreWindow(2), FIRST_TURNS)
  assert.equal(restoreWindow(50), 51)
})

test('一批批补，补到全为止', () => {
  assert.equal(growWindow(FIRST_TURNS, 1000), FIRST_TURNS + MORE_TURNS)
  assert.equal(growWindow(FIRST_TURNS, FIRST_TURNS + 3), FIRST_TURNS + 3)
  assert.equal(growWindow(30, 30), 30)
  assert.equal(growWindow(40, 10), 40, '画的比总数多（回合被删了）就不动')
})
