import assert from 'node:assert/strict'
import test from 'node:test'
import { ProtocolError, pageThreadItems } from '../../shared/src/protocol-contract.mjs'

// 共用的条目分页（Pi、DSH、OpenCode、ACP 直接把 thread/items/list 的参数交给它，Claude 也走它）
const turns = [
  { id: 't1', items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
  { id: 't2', items: [{ id: 'd' }] },
]
const ids = (page: { data: { item: { id: string } }[] }) => page.data.map((entry) => entry.item.id)

test('条目分页：不给方向时照上游按升序，条目锚点给它之后的；降序给它之前的', () => {
  assert.deepEqual(ids(pageThreadItems('th', turns, {})), ['a', 'b', 'c', 'd'])
  const anchor = { type: 'item', itemId: 'b' }
  assert.deepEqual(ids(pageThreadItems('th', turns, { turnId: 't1', cursor: anchor })), ['c'])
  assert.deepEqual(
    ids(pageThreadItems('th', turns, { turnId: 't1', cursor: anchor, sortDirection: 'desc' })),
    ['a'],
  )
  // 锚点那一页给出的游标接着翻
  const first = pageThreadItems('th', turns, {
    turnId: 't1',
    cursor: { type: 'item', itemId: 'a' },
    limit: 1,
  })
  assert.deepEqual(ids(first), ['b'])
  assert.deepEqual(ids(pageThreadItems('th', turns, { turnId: 't1', cursor: first.nextCursor })), [
    'c',
  ])
})

test('条目分页：锚点不带 turnId、指不到条目、形状不对，都按上游的话术拒绝', () => {
  const rejects = (params: Record<string, unknown>, message: string | RegExp) =>
    assert.throws(
      () => pageThreadItems('th', turns, params),
      (error: unknown) =>
        error instanceof ProtocolError &&
        error.code === -32602 &&
        (typeof message === 'string' ? error.message === message : message.test(error.message)),
    )
  rejects(
    { cursor: { type: 'item', itemId: 'a' } },
    'turnId is required when cursor is an item anchor',
  )
  rejects(
    { turnId: 't2', cursor: { type: 'item', itemId: 'a' } },
    'cursor.itemId does not identify an item in the requested history scope',
  )
  rejects({ turnId: 't1', cursor: { type: 'turn', itemId: 'a' } }, /游标/)
})
