import assert from 'node:assert/strict'
import test from 'node:test'
import { type DshThread, Projection, type WireEvent } from '../src/projection.mjs'

// dsh 回合中途的自动压缩（compaction/start、compaction/end）照上游投成 contextCompaction 条目：
// 开始时发开始，压成了发完成；没压成撤掉条目、不发完成。直接喂 dsh 的事件，不起 dsh。

const thread: DshThread = {
  id: 's1',
  cwd: '/tmp',
  name: null,
  preview: '',
  createdAt: 0,
  updatedAt: 0,
  model: null,
  effort: null,
  preset: 'workspace-write',
  parentThreadId: null,
  forkedFromId: null,
  ephemeral: false,
}

test('DSH 重启后的短快照没有turn/start时，从持久投影的末次编号继续，不从1重来', () => {
  const projection = new Projection(thread)
  projection.restoreTurnNumber(42)
  projection.restoreTurnNumber(7)
  projection.restoreTurnNumber(undefined)
  assert.equal(projection.expect(() => {}).id, 'turn:43')
})

function scene() {
  const sent: { method: string; params: any }[] = []
  const notify = (method: string, params: any) => sent.push({ method, params })
  const projection = new Projection({ ...thread })
  let seq = 0
  const apply = (type: string, data: any) =>
    projection.apply({ type, seq: ++seq, time: 1000 * seq, data } satisfies WireEvent, notify)
  apply('turn/start', { turn: 1 })
  const compaction = (method: string) =>
    sent.filter((n) => n.method === method && n.params.item?.type === 'contextCompaction')
  return { projection, apply, compaction }
}

test('dsh 自动压缩：compaction/start 发开始，compaction/end 发完成', () => {
  const { projection, apply, compaction } = scene()
  apply('compaction/start', { compactionId: 'c1', turn: 1 })
  assert.deepEqual(
    compaction('item/started').map((n) => n.params.item),
    [{ type: 'contextCompaction', id: 'compact:c1' }],
  )
  assert.equal(compaction('item/completed').length, 0)
  apply('compaction/summary', { compactionId: 'c1', summary: '摘要' })
  apply('compaction/end', { compactionId: 'c1', turn: 1 })
  assert.equal(compaction('item/completed').length, 1)
  apply('turn/end', { reason: { kind: 'completed' } })
  assert.equal(compaction('item/completed').length, 1)
  assert.deepEqual(
    projection.turns.at(-1)?.items.map((item) => item.type),
    ['contextCompaction'],
  )
})

test('dsh 自动压缩没压成：条目撤掉，回合结束也不发完成', () => {
  const { projection, apply, compaction } = scene()
  apply('compaction/start', { compactionId: 'c2', turn: 1 })
  apply('compaction/end', { compactionId: 'c2', turn: 1, error: [{ message: '摘要失败' }] })
  apply('turn/end', { reason: { kind: 'completed' } })
  assert.equal(compaction('item/started').length, 1)
  assert.equal(compaction('item/completed').length, 0)
  assert.deepEqual(projection.turns.at(-1)?.items, [])
})
