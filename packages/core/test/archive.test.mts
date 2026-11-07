import assert from 'node:assert/strict'
import test from 'node:test'
import { assertArchiveChildrenStopped } from '../src/archive.mjs'
import { RpcError } from '../src/connection/rpc.mjs'
import { channelFailure } from '../src/device/faults.mjs'
import { projectSummary } from '../src/projection/session.mjs'
import { thread } from './fixtures.mjs'

const summary = (id: string, parentId: string | null, state = 'idle', running = 0) => ({
  ...projectSummary(thread({ id, name: `会话 ${id}` }), { harness: 'pi', workspaceId: null }),
  status: state as 'idle' | 'running' | 'waiting',
  ...(parentId
    ? {
        lineage: {
          parentId,
          title: `会话 ${id}`,
          kind: 'fresh' as const,
          origin: 'user' as const,
          wakeParent: false,
          reportParent: true,
          createdAt: 1,
          proposalId: null,
        },
      }
    : {}),
  background: running ? { running, tasks: [], wakesOnFinish: null } : null,
})

for (const state of ['running', 'waiting', 'background']) {
  test(`核心拒绝 ${state} 后代归档，名单保留标题与 ID，不受中间线空闲或置顶影响`, () => {
    const rows = [
      summary('parent', null),
      { ...summary('middle', 'parent'), pinned: true },
      summary(
        'leaf',
        'middle',
        state === 'background' ? 'idle' : state,
        state === 'background' ? 1 : 0,
      ),
    ]
    assert.throws(
      () => assertArchiveChildrenStopped('parent', rows),
      (error: any) => {
        assert.equal(error.code, 'busy')
        assert.equal(error.text.key, 'session.archiveChildrenRunning')
        assert.match(error.text.args.sessions, /会话 leaf \(leaf\)/)
        return true
      },
    )
    assert.doesNotThrow(() => assertArchiveChildrenStopped('unrelated', rows))
    assert.doesNotThrow(
      () => assertArchiveChildrenStopped('leaf', rows),
      '不改变归档目标本身的既有规则',
    )
    assert.doesNotThrow(() =>
      assertArchiveChildrenStopped(
        'parent',
        rows.map((row) => ({ ...row, status: 'idle' as const, background: null })),
      ),
    )
  })
}

test('未载入后代由设备拒绝：两端共享的通道错误带完整名单与可翻译提示', () => {
  const error = channelFailure(
    new RpcError(-32600, 'Stop sub-sessions before archiving', {
      litch: 'archiveBlocked',
      threadId: 'parent',
      blockingSessions: [
        { threadId: 'a', title: '代码实现' },
        { threadId: 'b', title: '回归验收' },
      ],
    }),
  )
  assert.equal(error.code, 'busy')
  assert.equal(error.text?.key, 'session.archiveChildrenRunning')
  assert.deepEqual(error.text?.args, { sessions: '代码实现 (a), 回归验收 (b)' })
})
