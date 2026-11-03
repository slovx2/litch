import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { treeRig } from './tree-kit.mjs'

test('列表和看板各只读一次全历史；帖子版本与单独读取一致', async () => {
  const env = treeRig()
  const owner = env.device.managers
  try {
    owner.store.saveManager({
      id: 'bench',
      threadId: 'bench-thread',
      name: '隔离经理',
      cwd: env.stateDir,
      harness: 'pi',
      model: null,
      effort: null,
      scope: '',
      template: 'blank',
      rules: '',
      dispatch: { ...MANAGER_DEFAULT_DISPATCH },
      contact: { ...MANAGER_DEFAULT_CONTACT },
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      endedAt: null,
      pendingDecisions: 0,
      runningLines: 0,
      latestActivity: null,
    })
    for (let i = 0; i < 3; i++) {
      const result = owner.writer.tool('bench', 'add', {
        kind: 'decision',
        decision: { title: `决策 ${i}`, background: '背景' },
      })
      const id = (result as { id: `D-${number}` }).id
      const before = owner.store.object('bench', id)
      assert.ok(before)
      const after = { ...before, title: `更新后的决策 ${i}`, revision: 2 }
      owner.store.saveObject('bench', after)
      owner.store.record('bench', id, 'manager', before, after, '更新依据')
    }
    const expected = ['D-1', 'D-2', 'D-3'].map((id) => owner.posts.get('bench', id))
    const changes = owner.store.changes.bind(owner.store)
    let reads = 0
    owner.store.changes = (id) => {
      reads++
      return changes(id)
    }
    const board = owner.board('bench')
    assert.equal(reads, 1)
    assert.deepEqual(board.posts, expected)
    assert.equal(board.changes.length, 6)
    assert.equal(board.posts?.[0]?.versions.length, 1)
    reads = 0
    await owner.call(MANAGER_METHOD.list, {}, true)
    assert.equal(reads, 1)
    reads = 0
    await owner.call(MANAGER_METHOD.boardRead, { managerId: 'bench' }, true)
    assert.equal(reads, 1, '身份校验不再构造第二份整板')
  } finally {
    await env.close()
  }
})
