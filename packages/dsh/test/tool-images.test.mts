import assert from 'node:assert/strict'
import test from 'node:test'
import { Projection } from '../src/projection.mjs'

test('dsh 工具附件号进入恢复队列，并绑定原条目/回合；用户图片与工具图片形状分开', () => {
  const projection = new Projection({ id: 's', cwd: '/tmp' } as any)
  const notify = () => {}
  projection.apply({ seq: 1, type: 'turn/start', time: 1000, data: { turn: 1 } }, notify)
  projection.apply(
    {
      seq: 2,
      type: 'tool/call',
      time: 1001,
      data: { callId: 'read', name: 'read', arguments: '{}' },
    },
    notify,
  )
  projection.apply(
    {
      seq: 3,
      type: 'tool/result',
      time: 1002,
      data: {
        message: {
          toolCallId: 'read',
          content: [{ type: 'image', attachment: { attachmentId: 'asset' } }],
        },
      },
    },
    notify,
  )
  const wanted = projection.unfetched[0]!
  assert.equal(wanted.attachmentId, 'asset')
  assert.equal(wanted.item, projection.turns[0]!.items[0])
  assert.equal(wanted.turnId, projection.turns[0]!.id)
  wanted.content.push({ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' })
  assert.equal(wanted.item.result.content.at(-1).data, 'aGVsbG8=')
})
