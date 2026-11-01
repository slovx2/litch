import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BOARD_GRIP,
  BOARD_MAX,
  BOARD_MIN,
  boardLayoutNow,
  boardLimit,
  CHAT_MIN,
  setBoardLayout,
  shownBoardWidth,
} from '../src/manager/board-layout.ts'

test('看板拖动上下限保留对话最低宽度，窄化不改保存值', () => {
  setBoardLayout({ width: 820, open: true })
  assert.equal(shownBoardWidth(820, 860), 860 - CHAT_MIN - BOARD_GRIP)
  assert.equal(boardLayoutNow().width, 820)
  assert.equal(shownBoardWidth(boardLayoutNow().width, 1600), 820)
  assert.equal(shownBoardWidth(-100, 1600), BOARD_MIN)
  assert.equal(boardLimit(3000), BOARD_MAX)
  setBoardLayout({ open: false })
  assert.equal(boardLayoutNow().width, 820)
  assert.equal(boardLayoutNow().open, false)
  setBoardLayout({ open: true, width: 560 })
})
