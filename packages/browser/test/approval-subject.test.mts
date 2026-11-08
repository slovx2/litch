import assert from 'node:assert/strict'
import test from 'node:test'
import { browserApprovalSubject } from '../src/approval-subject.mjs'

test('受控下载审批转成通用合同的 download 主题，字段原样带过去', () => {
  assert.deepEqual(
    browserApprovalSubject({
      kind: 'browserDownload',
      filename: 'report.pdf',
      origin: 'https://fixture.test',
      totalBytes: 1024,
    }),
    { kind: 'download', filename: 'report.pdf', origin: 'https://fixture.test', totalBytes: 1024 },
  )
})

test('网站审批保留来源与浏览器，内置浏览器标为 builtin', () => {
  assert.deepEqual(
    browserApprovalSubject({ kind: 'site', origin: 'https://a.test', url: 'https://a.test/x' }),
    { kind: 'site', origin: 'https://a.test', url: 'https://a.test/x', browser: 'builtin' },
  )
})
