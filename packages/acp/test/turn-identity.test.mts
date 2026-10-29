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
