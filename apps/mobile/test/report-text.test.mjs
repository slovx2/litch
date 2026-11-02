import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { noteView } from '../../../packages/core/src/projection/items.mts'
import { ReportText } from '../../../packages/ui/src/tree/report-text.ts'

test('手机回报保留来源与截断状态，展开读取全文且可收起', async () => {
  const note = noteView({
    threadId: 'child',
    turnId: 'original',
    title: '子会话',
    status: 'completed',
    excerpt: '摘要',
    truncated: true,
  })
  assert.equal(note.turnId, 'original')
  assert.equal(note.truncated, true)
  const full = '回报正文\n'.repeat(1000)
  const report = new ReportText(note, async () => ({ answer: full, error: null, pending: null }))
  assert.equal(report.expandable, true)
  await report.toggle()
  assert.equal(report.snapshot().text, full)
  assert.equal(report.snapshot().open, true)
  await report.toggle()
  assert.equal(report.snapshot().open, false)
  assert.equal(
    new ReportText({ ...note, truncated: false }, async () => {
      throw new Error('不应读取')
    }).expandable,
    false,
  )
})

test('手机小图标与回报同排，读屏说明加载/展开状态，点击不打开会话', () => {
  const source = readFileSync(
    new URL('../src/detail/proposals/EventCell.tsx', import.meta.url),
    'utf8',
  )
  assert.match(source, /channel.command\('session.peek'/)
  assert.match(source, /sessionId: threadId/)
  assert.match(source, /onPress=\{\(\) => void report.toggle\(\)\}/)
  assert.match(source, /accessibilityState=\{\{ expanded: state.open, disabled: state.busy \}\}/)
  assert.match(source, /noteRow: \{ flexDirection: 'row'/)
})
