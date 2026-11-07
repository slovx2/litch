import assert from 'node:assert/strict'
import test from 'node:test'
import { SAMPLE_TOOL_IMAGES } from '../../../packages/core/src/mock/sample-tool-images.mts'
import { RowBuilder } from '../src/core/rows.ts'

test('工具图片：折叠组保留去重图库，展开按工具显示，晚到图片不能复用旧行', () => {
  const builder = new RowBuilder()
  const item = {
    id: 'tool',
    kind: 'toolCall',
    source: 'mcp',
    tool: 'Read',
    status: 'completed',
    input: [],
    output: [],
    error: null,
    durationMs: 1,
  }
  const view = {
    forkedFrom: null,
    can: { finalOnStart: false },
    agents: [],
    proposals: [],
    requests: [],
    turns: [
      {
        id: 't',
        status: 'running',
        itemIds: ['tool'],
        startedAt: 1,
        durationMs: null,
        error: null,
      },
    ],
    items: { tool: item },
  }
  const first = builder.build(view, 'all').find((row) => row.type === 'group')
  assert.equal(first.images, undefined)
  view.items.tool = { ...item, images: SAMPLE_TOOL_IMAGES }
  const group = builder.build(view, 'all').find((row) => row.type === 'group')
  assert.notEqual(first, group)
  assert.deepEqual(group.images, SAMPLE_TOOL_IMAGES)
  builder.toggle(group.key, 't')
  const rows = builder.build(view, 'all')
  const step = rows.find((row) => row.type === 'step')
  assert.deepEqual(step.gallery, SAMPLE_TOOL_IMAGES)
  assert.deepEqual(step.item.images, SAMPLE_TOOL_IMAGES)
})
