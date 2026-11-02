import assert from 'node:assert/strict'
import test from 'node:test'
import { ReportText } from '../src/tree/report-text.ts'

test('截断回报按需展开全文，收起重开复用，短回报无入口也不读取', async () => {
  let calls = 0
  const full = '完整的回报\n'.repeat(800)
  const read = async () => {
    calls++
    return { answer: full, error: null, pending: null }
  }
  const short = new ReportText({ turnId: 't', truncated: false }, read)
  assert.equal(short.expandable, false)
  await short.toggle()
  assert.equal(calls, 0)
  const report = new ReportText({ turnId: 't', truncated: true }, read)
  assert.equal(report.expandable, true)
  await report.toggle()
  assert.equal(report.snapshot().text, full)
  assert.equal(report.snapshot().open, true)
  await report.toggle()
  assert.equal(report.snapshot().open, false)
  await report.toggle()
  assert.equal(calls, 1)
})

test('失败可重试；原回合缺失保留摘录；并发点击不重复请求', async () => {
  let attempt = 0
  const report = new ReportText({ turnId: 't', truncated: true }, async () => {
    if (++attempt === 1) throw new Error('offline')
    return { answer: null, error: null, pending: null }
  })
  await report.toggle()
  assert.match(report.snapshot().error.message, /offline/)
  await Promise.all([report.toggle(), report.toggle()])
  assert.equal(attempt, 2)
  assert.equal(report.snapshot().missing, true)
  assert.equal(report.snapshot().open, false)
  assert.equal(report.snapshot().busy, false)
})
