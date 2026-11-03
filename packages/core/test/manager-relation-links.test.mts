import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sampleManagers } from '../src/mock/sample-manager.mjs'
import { managerRelationGroups } from '../src/projection/manager-relations.mjs'

test('关联链接：请求自身链接与关系边合并，同一目标跨组也只显示一次', () => {
  const board = sampleManagers('local', 1000, 'zh-CN').boards[0]
  assert.ok(board)
  const request = board.requests?.[0]
  assert.ok(request)
  const target = { kind: 'file' as const, target: '/outside/STORE.md', label: '上架准备' }
  request.links = [target, { kind: 'file', target: '/other', label: null }]
  request.basis = [target]
  board.relations = ['related', 'derived'].map((kind, index) => ({
    id: String(index),
    kind: kind as 'related' | 'derived',
    from: { kind: 'issue', target: request.id },
    to: target,
    by: 'projection',
    at: 0,
  }))
  const before = JSON.stringify(board)
  const groups = managerRelationGroups(board, { kind: 'issue', target: request.id })
  assert.deepEqual(
    Object.values(groups)
      .flat()
      .map((link) => link.target),
    ['/outside/STORE.md', '/other'],
  )
  assert.equal(JSON.stringify(board), before, '展示投影不改原始看板')
})

test('文件、网址、分支、提交、会话、议题和事项都保留类型与完整目标', () => {
  const board = sampleManagers('local', 1000, 'zh-CN').boards[0]
  assert.ok(board)
  const kinds = ['file', 'url', 'branch', 'commit', 'thread', 'issue', 'item'] as const
  board.relations = kinds.map((kind, index) => ({
    id: String(index),
    kind: 'related',
    from: { kind: 'issue', target: 'P-1' },
    to: { kind, target: `target-${kind}`, label: kind },
    by: 'manager',
    at: 0,
  }))
  assert.deepEqual(
    managerRelationGroups(board, { kind: 'issue', target: 'P-1' }).related.map((link) => link.kind),
    kinds,
  )
})
