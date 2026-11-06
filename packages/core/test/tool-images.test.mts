import assert from 'node:assert/strict'
import test from 'node:test'
import { projectItem, type ToolCallItem, toolImagesOf } from '../src/index.mjs'
import { SAMPLE_TOOL_IMAGES } from '../src/mock/sample-tool-images.mjs'

test('工具图片投影跨MCP/动态工具/函数/imageView统一，缩略图与原图分离', () => {
  for (const type of ['mcpToolCall', 'dynamicToolCall', 'functionCallOutput', 'imageView']) {
    const item = projectItem({
      type,
      id: 'i',
      path: '/tmp/test.png',
      tool: 'read',
      name: 'read',
      litchToolImages: SAMPLE_TOOL_IMAGES,
    } as any) as ToolCallItem
    assert.equal(item.kind, 'toolCall')
    assert.deepEqual(item.images, SAMPLE_TOOL_IMAGES)
  }
})
test('超量/伪造尺寸/缩略图像素炸弹不进入可解码缩略图', () => {
  const first = SAMPLE_TOOL_IMAGES[0]!
  assert.equal(toolImagesOf(Array(99).fill(first)).length, 16)
  assert.deepEqual(toolImagesOf([{ ...first, width: 100000 }]), [])
  const item = projectItem({
    type: 'imageView',
    id: 'v',
    path: '/a',
    litchToolImages: [{ ...first, thumbnail: { ...first.thumbnail!, width: 1 } }],
  } as any) as ToolCallItem
  assert.equal(item.images![0]!.thumbnail, null)
})
