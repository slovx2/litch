// 对话区一次画多少个回合（src/transcript/turn-window.ts）：先画最后几个，回来时包住上次停的那一行，之后一批批补到全
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { FIRST_TURNS, MORE_TURNS, firstWindow, growWindow } = await import(
  '../src/transcript/turn-window.ts'
)

test('先画最后几个；上次停在更早的回合就多画到包住它', () => {
  assert.equal(firstWindow(null), FIRST_TURNS)
  assert.equal(firstWindow(2), FIRST_TURNS)
  assert.equal(firstWindow(50), 51)
})

test('一批批补，补到全为止', () => {
  assert.equal(growWindow(FIRST_TURNS, 1000), FIRST_TURNS + MORE_TURNS)
  assert.equal(growWindow(FIRST_TURNS, FIRST_TURNS + 3), FIRST_TURNS + 3)
  assert.equal(growWindow(30, 30), 30)
  assert.equal(growWindow(40, 10), 40, '画的比总数多（回合被删了）就不动')
})
