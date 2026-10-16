import assert from 'node:assert/strict'
import test from 'node:test'
import type { ElicitationRequest } from '@anthropic-ai/claude-agent-sdk'
import { elicitationResponse } from '../src/mcp-elicitation.mjs'

const form: ElicitationRequest = {
  serverName: 'fixture',
  mode: 'form',
  message: '请确认表单',
  requestedSchema: {
    type: 'object',
    properties: { value: { type: 'string', minLength: 1 } },
    required: ['value'],
  },
}
const url: ElicitationRequest = {
  serverName: 'fixture',
  mode: 'url',
  message: '请确认链接',
  url: 'http://127.0.0.1/fixture',
  elicitationId: 'fixture',
}

test('MCP 原生表单响应的空 metadata 转为 SDK 缺省且不修改输入', () => {
  const input = { action: 'accept', content: { value: 'CONFIRMED' }, _meta: null }
  assert.deepEqual(elicitationResponse(form, input), { action: 'accept', content: input.content })
  assert.equal(input._meta, null)
  const metadata = { trace: { optionalValue: null } }
  assert.deepEqual(elicitationResponse(form, { ...input, _meta: metadata })._meta, metadata)
})

test('MCP 原生 URL 接受和表单取消拒绝的 null 可选字段转为缺省', () => {
  for (const action of ['accept', 'decline', 'cancel']) {
    assert.deepEqual(elicitationResponse(url, { action, content: null, _meta: null }), { action })
    if (action !== 'accept')
      assert.deepEqual(elicitationResponse(form, { action, content: null, _meta: null }), {
        action,
      })
  }
})

test('MCP 空值映射不放宽 metadata 类型、表单 schema 或响应顶层约束', () => {
  for (const _meta of [[], 42, 'invalid', false])
    assert.throws(
      () => elicitationResponse(form, { action: 'accept', content: { value: 'x' }, _meta }),
      { code: -32602 },
    )
  for (const content of [null, undefined, {}, { value: 42 }, { value: '' }, [], 'invalid'])
    assert.throws(() => elicitationResponse(form, { action: 'accept', content, _meta: null }), {
      code: -32602,
    })
  for (const value of [null, [], 'invalid', 42, { action: 'unknown' }])
    assert.throws(() => elicitationResponse(form, value), { code: -32602 })
})
