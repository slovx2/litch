import assert from 'node:assert/strict'
import test from 'node:test'
import {
  boardPageMemory,
  managerBoardMemory,
} from '../../../packages/core/src/manager-board-memory.mts'
import { rememberBoardScroll } from '../src/screens/managers/board-return.ts'

for (const tab of ['suggestion', 'decision', 'item']) {
  test(`${tab} 跳出后隐藏容器归零不覆盖看板位置，恢复期旧事件也不覆盖`, () => {
    const memory = boardPageMemory(managerBoardMemory('test-return', tab), tab)
    const state = { memory, pending: false, y: 0 }
    rememberBoardScroll(state, 420, true)
    rememberBoardScroll(state, 0, false)
    assert.equal(memory.y, 420)
    state.pending = true
    rememberBoardScroll(state, 0, true)
    assert.equal(memory.y, 420)
    state.pending = false
    rememberBoardScroll(state, 250, true)
    assert.equal(memory.y, 250)
  })
}
