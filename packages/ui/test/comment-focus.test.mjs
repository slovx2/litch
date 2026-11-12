import assert from 'node:assert/strict'
import test from 'node:test'
import {
  focusCommentInput,
  onCommentFocus,
  requestCommentFocus,
} from '../src/composer/comment-focus.ts'

test('评论确认只通知所属会话，恢复草稿或取消没有确认请求就不抢焦点', () => {
  let active = 0
  let other = 0
  const off = onCommentFocus('nebula:one', () => active++)
  const offOther = onCommentFocus('nebula:two', () => other++)
  assert.equal(active, 0)
  requestCommentFocus('nebula:one')
  assert.equal(active, 1)
  assert.equal(other, 0)
  off()
  requestCommentFocus('nebula:one')
  assert.equal(active, 1, '离开会话后不再移动焦点')
  offOther()
})

test('评论确认后聚焦输入框末尾，不改草稿、不滚动页面', () => {
  const calls = []
  const input = {
    value: '星云草稿🌟',
    focus: (options) => calls.push(options),
    setSelectionRange: (start, end) => calls.push([start, end]),
  }
  focusCommentInput(input)
  assert.deepEqual(calls, [{ preventScroll: true }, [input.value.length, input.value.length]])
  assert.equal(input.value, '星云草稿🌟')
  focusCommentInput(null)
})
