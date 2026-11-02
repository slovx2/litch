import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatSessionEvent,
  parseSessionEvent,
  SESSION_NOTE_TRUNCATED,
  SESSION_TREE_LIMITS,
  sessionNoteExcerpt,
} from '../../protocol/src/session-tree.mjs'

test('回报摘录：短回答和边界不加标记，长回答及 emoji 不截开代理对', () => {
  for (const text of ['', '完整报告', 'x'.repeat(2000)])
    assert.equal(sessionNoteExcerpt(text), text)
  for (const text of ['长报告'.repeat(2000), '😀'.repeat(2000)]) {
    const excerpt = sessionNoteExcerpt(text)
    assert.ok(excerpt.length <= 2000)
    assert.ok(excerpt.endsWith(SESSION_NOTE_TRUNCATED))
    assert.doesNotMatch(excerpt, /[\uD800-\uDFFF]/u)
  }
})

test('多条回报：正文与 JSON 的摘录和错误共用预算，每条仍可定位原回合', () => {
  const notes = Array.from({ length: 24 }, (_, n) => ({
    threadId: `child-${n}`,
    turnId: `turn-${n}`,
    title: `任务 ${n}`,
    status: 'failed' as const,
    excerpt: '>\n"😀'.repeat(1000),
    error: '错误'.repeat(1500),
  }))
  const text = formatSessionEvent({ kind: 'wake', notes })
  const parsed = parseSessionEvent(text).event
  assert.ok(parsed)
  assert.equal(parsed.notes.length, 24)
  let cost = 0
  for (const [at, note] of parsed.notes.entries()) {
    assert.equal(note.turnId, `turn-${at}`)
    assert.equal(note.truncated, true)
    assert.ok(note.excerpt.endsWith(SESSION_NOTE_TRUNCATED))
    for (const value of [note.excerpt, note.error ?? '']) {
      cost += value.length + JSON.stringify(value).replace(/>/g, '\\u003e').length
      assert.doesNotMatch(value, /[\uD800-\uDFFF]/u)
    }
  }
  assert.ok(cost <= SESSION_TREE_LIMITS.noteBatchChars, String(cost))
  assert.ok(text.length < 32000, `包含标题、状态、标识、说明的整条唤醒消息：${text.length}`)
  assert.equal(notes[0]?.excerpt, '>\n"😀'.repeat(1000), '不修改持久化回报')
})

test('短回报原样往返，不误报截断', () => {
  const note = {
    threadId: 's',
    turnId: 't',
    title: '测试',
    status: 'completed' as const,
    excerpt: '完整报告',
  }
  assert.deepEqual(
    parseSessionEvent(formatSessionEvent({ kind: 'notes', notes: [note] })).event?.notes,
    [note],
  )
})

test('大量历史回报不能仅靠截断标记就耗尽整批预算', () => {
  const notes = Array.from({ length: 500 }, (_, n) => ({
    threadId: `s${n}`,
    turnId: 't',
    title: '',
    status: 'completed' as const,
    excerpt: '长'.repeat(3000),
  }))
  const event = parseSessionEvent(formatSessionEvent({ kind: 'notes', notes })).event
  assert.ok(event)
  const cost = event.notes.reduce(
    (sum, note) =>
      sum + (note.excerpt ? note.excerpt.length + JSON.stringify(note.excerpt).length : 0),
    0,
  )
  assert.ok(cost <= SESSION_TREE_LIMITS.noteBatchChars)
  assert.ok(event.notes.every((note) => note.truncated))
})
