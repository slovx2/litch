import assert from 'node:assert/strict'
import test from 'node:test'
import { cardInputMaxHeight, cardInputScroll } from '../src/ui/kit/card-input-layout.ts'

const base = {
  offset: 0,
  viewportTop: 200,
  viewportBottom: 320,
  inputTop: 290,
  inputHeight: 44,
  caretY: 20,
}

test('小屏多行框限高后完整装入视口，大屏保留原来的上限', () => {
  for (const viewport of [60, 80, 120, 240, 600]) {
    const height = cardInputMaxHeight(viewport, 160, 44)
    assert.ok(height >= 44 && height <= 160)
    assert.ok(height + 16 <= viewport)
  }
  assert.equal(cardInputMaxHeight(Number.POSITIVE_INFINITY, 120, 40), 120)
})

test('光标在视口内但输入框底边被截断时仍滚动，留下完整边框', () => {
  assert.equal(cardInputScroll(base), 22)
  const scroll = cardInputScroll(base)
  assert.ok(base.inputTop - scroll >= base.viewportTop)
  assert.ok(base.inputTop + base.inputHeight - scroll <= base.viewportBottom)
})

test('键盘与卡片落定后按真实视口校正，不按键盘顶边猜位置', () => {
  for (const viewportBottom of [320, 280, 250]) {
    const state = { ...base, viewportBottom }
    const scroll = cardInputScroll(state)
    assert.ok(state.inputTop - scroll >= state.viewportTop)
    assert.ok(state.inputTop + state.inputHeight - scroll <= state.viewportBottom)
  }
})

test('原焦点滚过头后，下一题可以向回滚到输入框上沿', () => {
  assert.equal(cardInputScroll({ ...base, offset: 180, inputTop: 170 }), 142)
})

test('完整可见的框保持位置，重复校正不会来回跳动', () => {
  const next = cardInputScroll(base)
  assert.equal(cardInputScroll({ ...base, offset: next, inputTop: base.inputTop - next }), next)
  assert.equal(cardInputScroll({ ...base, offset: 50, inputTop: 230 }), 50)
})

test('多行输入长高后让完整输入框露出', () => {
  const state = { ...base, viewportTop: 100, inputHeight: 160, inputTop: 210 }
  const scroll = cardInputScroll(state)
  assert.ok(state.inputTop - scroll >= state.viewportTop)
  assert.ok(state.inputTop + state.inputHeight - scroll <= state.viewportBottom)
})

test('极短视口放不下整个多行框时仍保护正在编辑的那一行', () => {
  assert.equal(cardInputScroll({ ...base, inputTop: 210, inputHeight: 160, caretY: 150 }), 40)
  assert.equal(
    cardInputScroll({ ...base, offset: 60, inputTop: 150, inputHeight: 160, caretY: 24 }),
    10,
  )
})

test('布局尚未有效时不滚动，不能产生负滚动位置', () => {
  assert.equal(cardInputScroll({ ...base, offset: 20, viewportBottom: 200 }), 20)
  assert.equal(cardInputScroll({ ...base, offset: 20, inputHeight: 0 }), 20)
  assert.equal(cardInputScroll({ ...base, offset: 0, inputTop: 190 }), 0)
})
