// 输入区那一排（src/detail/composer/layout.ts）：＋、输入框、发送/停止三者等高、上下边对齐。
// 回合进行中的占位文字在窄屏上折成两行时输入框会长高，两边按钮得跟着拉高，不能钉死高度、靠底对齐
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ONE_LINE, ROW_MIN, rowLayout } from '../src/detail/composer/layout.ts'

test('一排按 stretch 排，两边按钮跟着输入框的实际高度走', () => {
  assert.equal(rowLayout.row.flexDirection, 'row')
  assert.equal(rowLayout.row.alignItems, 'stretch')
  for (const name of ['side', 'send']) {
    const style = rowLayout[name]
    assert.equal(style.height, undefined, `${name} 不能有固定 height`)
    assert.equal(style.maxHeight, undefined, `${name} 不能有 maxHeight`)
    assert.equal(style.alignSelf, undefined, `${name} 不能自己另定对齐`)
    assert.equal(style.minHeight, ROW_MIN, `${name} 的最小高度和输入框一行一样`)
  }
})

test('输入框一行正好和按钮的最小高度一样，没内容时三者都是 ROW_MIN', () => {
  assert.equal(rowLayout.input.minHeight, ROW_MIN)
  assert.equal(ONE_LINE, ROW_MIN)
  assert.ok(rowLayout.input.maxHeight > ROW_MIN)
})
