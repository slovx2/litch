import assert from 'node:assert/strict'
import test from 'node:test'
import { keyboardFormLayout } from '../src/ui/kit/keyboard-layout.ts'

const base = { windowHeight: 800, viewportBottom: 800, actionHeight: 44, contained: false }

test('普通长表单为提交按钮留一行，键盘空间交给滚动组件', () => {
  assert.deepEqual(keyboardFormLayout({ ...base, keyboardHeight: 300 }), {
    bottomOffset: 60,
    extraKeyboardSpace: 0,
  })
})

test('看板固定提交条与弹层下边距都计入焦点的安全距离', () => {
  assert.deepEqual(
    keyboardFormLayout({ ...base, viewportBottom: 440, keyboardHeight: 300, contained: true }),
    {
      bottomOffset: 120,
      extraKeyboardSpace: -300,
    },
  )
})

test('高候选栏改变后不重复补偿键盘，收起恢复原布局', () => {
  for (const keyboardHeight of [300, 400, 0]) {
    const result = keyboardFormLayout({
      ...base,
      keyboardHeight,
      viewportBottom: 800 - keyboardHeight - 60,
      contained: true,
    })
    assert.equal(result.extraKeyboardSpace + keyboardHeight, 0)
    assert.equal(result.bottomOffset, keyboardHeight ? 120 : 60)
  }
})

test('尚未测量与浮动键盘不生成负偏移，按钮变高时相应留白', () => {
  assert.deepEqual(
    keyboardFormLayout({ ...base, viewportBottom: null, keyboardHeight: 0, actionHeight: 88 }),
    {
      bottomOffset: 104,
      extraKeyboardSpace: 0,
    },
  )
  assert.equal(
    keyboardFormLayout({ ...base, keyboardHeight: -20, actionHeight: -1 }).bottomOffset,
    16,
  )
})

test('iOS 完成条占据的空间只避让一次，数字和多行键盘共用同一规则', () => {
  const standalone = keyboardFormLayout({ ...base, keyboardHeight: 300, accessoryHeight: 44 })
  assert.equal(standalone.bottomOffset, 104)
  assert.equal(standalone.extraKeyboardSpace, 44)
  const contained = keyboardFormLayout({
    ...base,
    keyboardHeight: 300,
    accessoryHeight: 44,
    contained: true,
    viewportBottom: 456,
  })
  assert.equal(contained.bottomOffset, standalone.bottomOffset)
  assert.equal(contained.extraKeyboardSpace, -300)
  assert.equal(
    keyboardFormLayout({ ...base, keyboardHeight: 0, accessoryHeight: 44, contained: true })
      .extraKeyboardSpace,
    0,
  )
})

test('高候选栏和短请求卡为首次聚焦的多行框留位置，不让按钮余量把首行推过顶部', () => {
  const layout = keyboardFormLayout({
    ...base,
    keyboardHeight: 500,
    viewportTop: 200,
    viewportBottom: 300,
    actionHeight: 96,
  })
  assert.equal(layout.bottomOffset, 20)
  assert.equal(
    keyboardFormLayout({ ...base, keyboardHeight: 600, viewportTop: 200, viewportBottom: 300 })
      .bottomOffset,
    0,
  )
})

test('不同高度的输入框按实际尺寸限制操作余量，配对文本不会被当成单行框', () => {
  const form = {
    ...base,
    keyboardHeight: 400,
    viewportTop: 100,
    viewportBottom: 800,
    actionHeight: 180,
  }
  assert.equal(keyboardFormLayout({ ...form, inputHeight: 120 }).bottomOffset, 180)
  assert.equal(keyboardFormLayout({ ...form, inputHeight: 160 }).bottomOffset, 140)
  assert.equal(keyboardFormLayout({ ...form, inputHeight: 44 }).bottomOffset, 196)
})
