import assert from 'node:assert/strict'
import test from 'node:test'
import { Projection } from '../src/projection.mjs'

const thread = {
  id: 's',
  cwd: '/tmp',
  name: null,
  preview: '',
  createdAt: 1,
  updatedAt: 1,
  forkedFromId: null,
  ephemeral: false,
}
const image = { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }
for (const single of [false, true])
  test(`ACP 图片结果：${single ? '历史仅completed一帧' : '图片和完成分开两帧'}`, () => {
    const projection = new Projection(thread)
    const turn = projection.begin(() => {})
    projection.update(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'read',
        title: 'Read',
        kind: 'read',
        status: single ? 'completed' : 'in_progress',
        content: [{ type: 'content', content: image }],
      },
      () => {},
    )
    if (!single)
      projection.update(
        { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed' },
        () => {},
      )
    assert.equal(turn.items[0].status, 'completed')
    assert.deepEqual(turn.items[0].result.content, [image])
    const reopened = new Projection(thread)
    projection.finish({ stopReason: 'end_turn' }, () => {})
    reopened.restore(projection.snapshot())
    assert.deepEqual(reopened.turns[0]!.items[0].result.content, [image])
  })
