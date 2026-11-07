import assert from 'node:assert/strict'
import test from 'node:test'
import { proposalSummary } from '../src/tree/proposal-brief.ts'

test('摘要选背景首句，缺背景退回任务；去排版、保留文件名与版本号', () => {
  assert.equal(proposalSummary('第一句解释问题。第二句细节。', '任务全文'), '第一句解释问题。')
  assert.equal(proposalSummary('  ', 'No tests exist. Add tests.'), 'No tests exist.')
  assert.equal(
    proposalSummary('# 背景\n**v0.35.1** 的 [file.ts](file.ts) 会报错，需要修复。\n细节', ''),
    'v0.35.1 的 file.ts 会报错，需要修复。',
  )
  assert.equal(
    proposalSummary('See https://example.com/a. Then fix.', ''),
    'See https://example.com/a.',
  )
  assert.equal(proposalSummary('', ''), '')
  assert.equal(Array.from(proposalSummary('😀'.repeat(220), '')).length, 201)
})
