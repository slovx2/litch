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
test('ACP 实时回合在丢失进行中快照、同一毫秒重启后仍使用不同ID，已存历史ID不变', () => {
  const first = new Projection(thread)
  const old = first.beginLive(() => {}, 1000)
  const snapshot = first.snapshot()
  assert.equal(snapshot.length, 0)
  const restarted = new Projection(thread)
  restarted.restore(snapshot)
  const next = restarted.beginLive(() => {}, 1000)
  assert.notEqual(old.id, next.id)
  restarted.finish({ stopReason: 'end_turn' }, () => {}, 1001)
  const recovered = new Projection(thread)
  recovered.restore(restarted.snapshot())
  assert.equal(recovered.turns[0]?.id, next.id)
  const replay = new Projection(thread)
  assert.equal(replay.begin(() => {}, 1000).id, 'turn:1', '原生历史回放仍为确定性编号')
})

test('后台快照补后半句时原地更新同一条目，保留图片与真实工具状态', () => {
  const projection = new Projection({ ...thread })
  const sent: { method: string; params: any }[] = []
  const notify = (method: string, params: any) => sent.push({ method, params })
  const tool = {
    sessionUpdate: 'tool_call',
    toolCallId: 'read-image',
    kind: 'read',
    title: 'Read',
    status: 'in_progress',
    content: [
      { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' } },
    ],
  }
  const message = (text: string) => ({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
  })
  projection.backgroundSnapshot('bg', [tool, message('前半句')], notify)
  assert.equal(projection.turns[0]?.items[0].status, 'inProgress')
  const id = projection.turns[0]?.items[1].id
  projection.backgroundSnapshot(
    'bg',
    [{ ...tool, status: 'completed' }, message('前半句后半句')],
    notify,
  )
  assert.equal(projection.turns.length, 1)
  assert.equal(projection.turns[0]?.items.length, 2)
  assert.equal(projection.turns[0]?.items[1].id, id)
  assert.equal(projection.turns[0]?.items[1].text, '前半句后半句')
  assert.equal(projection.turns[0]?.items[0].status, 'completed')
  assert.equal(projection.turns[0]?.items[0].result.content[0].type, 'image')
  assert.equal(
    sent.filter((event) => event.method === 'item/started' && event.params.item.id === id).length,
    1,
  )
  assert.equal(projection.origins.get('bg'), 'backgroundTask')
  assert.equal(projection.active, null)
})
