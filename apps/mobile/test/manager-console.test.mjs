import assert from 'node:assert/strict'
import test from 'node:test'
import { managerAttentionCount } from '../../../packages/core/src/projection/manager.mts'
import { relationGroups } from '../../../packages/protocol/src/manager-relations.mts'
import { issueLinks } from '../src/screens/managers/relations.ts'

test('手机议题编号只链接存在对象，保留代码与明确链接', () => {
  const ids = new Set(['D-1', 'I-2', 'P-3'])
  assert.equal(
    issueLinks('#D-1、I-2 与 #P-3；#D-999 `#D-1` [原链接](https://x/#D-1)', ids),
    '[#D-1](litch-issue:D-1)、[I-2](litch-issue:I-2) 与 [#P-3](litch-issue:P-3)；#D-999 `#D-1` [原链接](https://x/#D-1)',
  )
})
test('同一关系正向是来源，反向是派生；相关关系双向对称', () => {
  const a = { kind: 'issue', target: 'P-1' },
    b = { kind: 'item', target: 'I-1' }
  const edge = { id: 'one', from: a, to: b, kind: 'derived', at: 1, by: 'manager' }
  assert.deepEqual(relationGroups([edge], a).source, [b])
  assert.deepEqual(relationGroups([edge], b).derived, [a])
  assert.deepEqual(relationGroups([{ ...edge, kind: 'related' }], b).related, [a])
})

test('D-29：手机使用核心统一口径，报告未读不占待处理', () => {
  const manager = {
    pendingDecisions: 3,
    pendingRequests: 1,
    pendingSuggestions: 2,
    pendingReports: 9,
  }
  assert.equal(managerAttentionCount(manager), 6)
  assert.equal(managerAttentionCount({ ...manager, pendingReports: 0 }), 6)
  assert.equal(
    managerAttentionCount({
      ...manager,
      pendingDecisions: 0,
      pendingRequests: 0,
      pendingSuggestions: 0,
    }),
    0,
  )
})
