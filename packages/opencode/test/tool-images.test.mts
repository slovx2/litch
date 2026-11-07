import assert from 'node:assert/strict'
import test from 'node:test'
import { finishTool } from '../src/items.mjs'

test('OpenCode 普通read/MCP和动态工具均保留state.attachments的图片', () => {
  for (const type of ['mcpToolCall', 'dynamicToolCall']) {
    const item: any = { type, id: 'tool', namespace: 'litch_browser' }
    finishTool(
      item,
      {
        state: {
          status: 'completed',
          output: '已读',
          attachments: [{ mime: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }],
        },
      },
      '/tmp',
      null,
    )
    assert.equal(item.status, 'completed')
    if (type === 'mcpToolCall')
      assert.deepEqual(item.result.content[1], {
        type: 'image',
        mimeType: 'image/png',
        data: 'aGVsbG8=',
      })
    else
      assert.deepEqual(item.contentItems[1], {
        type: 'inputImage',
        imageUrl: 'data:image/png;base64,aGVsbG8=',
      })
  }
})
