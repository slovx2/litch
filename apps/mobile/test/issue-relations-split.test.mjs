// 完整议题页的关联去重（src/screens/managers/relations.ts 的 threadRelationTargets）：
// 特殊议题的卡只画看板给的关联（设备去掉了一端是 X-n 的边），讨论区那一行只补和普通议题之间的关联，同一条不出现两次。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { threadRelationTargets } from '../src/screens/managers/relations.ts'

const issue = (target) => ({ kind: 'issue', target })
const edge = (from, to) => ({ from, to })
const relations = [
  edge(issue('D-186'), issue('I-1')),
  edge(issue('X-3'), issue('D-186')),
  edge(issue('D-186'), issue('X-7')),
  edge(issue('D-186'), { kind: 'file', target: 'docs/a.md' }),
  edge(issue('D-9'), issue('X-8')),
]

test('D-n 关联 X-n：有议题卡时讨论区只补普通议题那几条，卡上已有的不重复', () => {
  assert.deepEqual(threadRelationTargets('D-186', relations, true), [issue('X-3'), issue('X-7')])
})

test('D-n 只有卡上能看到的关联时，讨论区不再画关联这一行', () => {
  assert.deepEqual(threadRelationTargets('D-9', relations.slice(0, 1), true), [])
})

test('普通议题没有议题卡：两个方向的关联都画，与别的议题无关的边不算', () => {
  assert.deepEqual(threadRelationTargets('X-7', relations, false), [issue('D-186')])
  assert.deepEqual(threadRelationTargets('D-186', relations, false), [
    issue('I-1'),
    issue('X-3'),
    issue('X-7'),
    { kind: 'file', target: 'docs/a.md' },
  ])
})
