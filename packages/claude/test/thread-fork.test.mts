import assert from 'node:assert/strict'
import test from 'node:test'
import { ProtocolError } from '../src/protocol-contract.mjs'
import { forkPositionFromParams, forkRetainedTurns } from '../src/thread-fork.mjs'
import type { TurnRecord } from '../src/types.mjs'

function turn(id: string, status: TurnRecord['status'] = 'completed'): TurnRecord {
  return {
    id,
    threadId: 'thread',
    status,
    startedAt: 1,
    completedAt: status === 'inProgress' ? null : 2,
    durationMs: null,
    items: [],
    diff: '',
    error: null,
  }
}

function rejects(action: () => unknown, message: RegExp): void {
  assert.throws(action, (error) => {
    assert.ok(error instanceof ProtocolError)
    assert.equal(error.code, -32602)
    assert.match(error.message, message)
    return true
  })
}

test('分叉位置参数：缺省整份复制，两个同时给或类型不对即拒绝', () => {
  assert.equal(forkPositionFromParams({}), null)
  assert.equal(forkPositionFromParams({ lastTurnId: null, beforeTurnId: null }), null)
  assert.deepEqual(forkPositionFromParams({ lastTurnId: 'a' }), { kind: 'through', turnId: 'a' })
  assert.deepEqual(forkPositionFromParams({ beforeTurnId: 'b', lastTurnId: null }), {
    kind: 'before',
    turnId: 'b',
  })
  rejects(
    () => forkPositionFromParams({ lastTurnId: 'a', beforeTurnId: 'b' }),
    /beforeTurnId 不能与 lastTurnId 同时指定/,
  )
  rejects(() => forkPositionFromParams({ lastTurnId: 1 }), /lastTurnId 必须是字符串/)
  rejects(() => forkPositionFromParams({ beforeTurnId: ['a'] }), /beforeTurnId 必须是字符串/)
})

test('分叉位置决定带走的回合：lastTurnId 含这一轮，beforeTurnId 不含', () => {
  const turns = [turn('a'), turn('b', 'interrupted'), turn('c', 'failed'), turn('d')]
  const ids = (position: Parameters<typeof forkRetainedTurns>[1]) =>
    forkRetainedTurns(turns, position).map((entry) => entry.id)
  assert.equal(forkRetainedTurns(turns, null), turns, '不带位置时原样带走')
  assert.deepEqual(ids({ kind: 'before', turnId: 'a' }), [], '切在第一轮之前得到空分叉')
  assert.deepEqual(ids({ kind: 'before', turnId: 'c' }), ['a', 'b'])
  assert.deepEqual(ids({ kind: 'through', turnId: 'a' }), ['a'])
  assert.deepEqual(ids({ kind: 'through', turnId: 'b' }), ['a', 'b'], '被打断的回合可以作为终点')
  assert.deepEqual(ids({ kind: 'through', turnId: 'c' }), ['a', 'b', 'c'], '失败的回合可以作为终点')
  assert.deepEqual(ids({ kind: 'through', turnId: 'd' }), ['a', 'b', 'c', 'd'])
  rejects(() => ids({ kind: 'through', turnId: 'x' }), /lastTurnId 不属于此会话的当前历史/)
  rejects(() => ids({ kind: 'before', turnId: 'x' }), /beforeTurnId 不属于此会话的当前历史/)
  rejects(() => ids({ kind: 'through', turnId: '' }), /lastTurnId 不属于此会话的当前历史/)
  rejects(() => forkRetainedTurns([], { kind: 'before', turnId: 'a' }), /beforeTurnId 不属于/)
})

test('分叉位置遇到进行中的回合：不能保留到它，可以切在它之前', () => {
  const turns = [turn('a'), turn('b', 'inProgress')]
  rejects(
    () => forkRetainedTurns(turns, { kind: 'through', turnId: 'b' }),
    /lastTurnId 指向的回合仍在进行中/,
  )
  assert.deepEqual(
    forkRetainedTurns(turns, { kind: 'before', turnId: 'b' }).map((entry) => entry.id),
    ['a'],
  )
})
