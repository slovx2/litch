import assert from 'node:assert/strict'
import test from 'node:test'
import { finishTool } from '../src/projection.mjs'

test('Pi Read/MCP 工具结果保留图片块，实时与历史共用收尾', () => {
  const content = [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }]
  const item: any = { type: 'mcpToolCall', id: 'read', tool: 'read' }
  finishTool(item, { content }, false, {})
  assert.deepEqual(item.result.content, content)
  assert.equal(item.status, 'completed')
})
