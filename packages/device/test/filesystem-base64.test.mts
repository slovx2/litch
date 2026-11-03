import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeBase64 } from '../../shared/src/filesystem-rpc.mjs'

test('文件和标准输入的 Base64 校验接受大块数据且仍拒绝坏格式', () => {
  // 分组重复的正则会在大文件上耗尽 V8 的匹配栈；远程复制一次传 4 MiB。
  const bytes = Buffer.alloc(4 * 1024 * 1024, 0xa5)
  assert.deepEqual(decodeBase64(bytes.toString('base64')), bytes)
  for (const value of ['', 'YQ==', 'YWI=', 'YWJj'])
    assert.deepEqual(decodeBase64(value), Buffer.from(value, 'base64'))
  for (const value of [null, 1, 'A', 'A===', 'YQ=', 'YQ===', 'YW=J', 'YWJj\n', '!!!!'])
    assert.throws(() => decodeBase64(value), /base64/)
})
