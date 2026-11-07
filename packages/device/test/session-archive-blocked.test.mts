import assert from 'node:assert/strict'
import test from 'node:test'
import { MANAGER_DEFAULT_CONTACT, MANAGER_DEFAULT_DISPATCH } from '../../protocol/src/manager.mjs'
import { startChild } from '../src/session-start.mjs'
import { failureOf } from './fake-engine.mjs'
import { litch, parent, treeRig, until } from './tree-kit.mjs'

for (const manager of [false, true]) {
  for (const state of ['running', 'waiting', 'background'] as const) {
    test(`归档完整后代树：${manager ? '经理' : '普通'} ${state} 在所有入口阻止整次归档并列名单`, async () => {
      const env = treeRig()
      try {
        const desktop = await litch(env)
        const phone = await litch(env)
        const { threadId } = await parent(desktop)
        const tree = env.device.sessionTree
        if (manager)
          env.device.managers.store.saveManager({
            id: 'manager',
            threadId,
            name: '经理',
            cwd: env.stateDir,
            harness: 'pi',
            model: null,
            effort: null,
            scope: '',
            template: 'blank',
            rules: '',
            dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false },
            contact: { ...MANAGER_DEFAULT_CONTACT },
            status: 'active',
            createdAt: 1,
            updatedAt: 1,
            endedAt: null,
            pendingDecisions: 0,
            runningLines: 0,
            latestActivity: null,
          })
        const spawn = (source: string, title: string) =>
          startChild(
            tree,
            source,
            {
              title,
              prompt: '隔离验收',
              kind: 'fresh',
              worktree: false,
              wakeParent: false,
            },
            'user',
          )
        const middle = await spawn(threadId, '已停止的中间线')
        const child = await spawn(middle.threadId, '第三层的活跃工作线')
        const another = await spawn(threadId, '另一个活跃子会话')
        env.pi.end(middle.threadId)
        if (state !== 'running') env.pi.end(child.threadId)
        await until(
          () =>
            !tree.isActive(middle.threadId) &&
            (state === 'running' || !tree.isActive(child.threadId)),
          '中间线停止',
        )
        const originalRead = env.pi.handlers['thread/read']
        assert.ok(originalRead)
        if (state === 'waiting')
          env.pi.handlers['thread/read'] = (params, connection) => {
            const result = originalRead(params, connection) as any
            if (params.threadId === child.threadId)
              result.thread.status = { type: 'idle', activeFlags: ['waitingOnUserInput'] }
            return result
          }
        if (state === 'background')
          env.device.background.reportedChanged({
            threadId: child.threadId,
            tasks: [{ id: 'bg', kind: 'shell', title: '后台命令', status: 'running' }],
          })
        // 桌面、手机及经理界面最终发送同一个协议方法，不靠界面隐藏按钮拦截。
        for (const client of [desktop, phone]) {
          const failure = await client.fails('thread/archive', { threadId })
          assert.ok(failure.data, JSON.stringify(failure))
          assert.equal(failure.data.litch, 'archiveBlocked')
          assert.deepEqual(
            new Set(failure.data.blockingSessions.map((s: any) => s.threadId)),
            new Set([child.threadId, another.threadId]),
          )
          assert.match(failure.message, /第三层的活跃工作线/)
          assert.match(failure.message, /另一个活跃子会话/)
        }
        const failedTool = await env.pi.callTool(threadId, 'litch_sessions', 'archive', {
          thread_id: middle.threadId,
        })
        assert.equal(failureOf(failedTool?.answer), 'blocked')
        assert.match(JSON.stringify(failedTool?.answer), /第三层的活跃工作线/)
        const self = await env.pi.callTool(threadId, 'litch_sessions', 'archive', {
          thread_id: 'self',
        })
        assert.equal(failureOf(self?.answer), 'blocked')
        await assert.rejects(
          env.device.archives.archive(threadId, 'model'),
          /Stop sub-sessions before archiving/,
        )
        assert.equal(env.pi.sent('thread/archive').length, 0, '任何拒绝都不得发给引擎或部分归档')
        assert.equal(env.pi.running(threadId), true, '拒绝时也不停止父回合')
        // 已归档的中间节点不遮住活跃后代。
        tree.host.index.setArchived(middle.threadId, true)
        await assert.rejects(
          env.device.archives.assertChildrenStopped(threadId),
          /第三层的活跃工作线/,
        )
        tree.host.index.setArchived(middle.threadId, false)
        env.pi.handlers['thread/read'] = originalRead
        env.device.background.reportedChanged({ threadId: child.threadId, tasks: [] })
        if (env.pi.running(child.threadId)) env.pi.end(child.threadId)
        env.pi.end(another.threadId)
        await until(
          () => !tree.isActive(child.threadId) && !tree.isActive(another.threadId),
          '后代全部停止',
        )
        await desktop.call('thread/archive', { threadId })
        await until(
          () =>
            [threadId, middle.threadId, child.threadId, another.threadId].every(
              (id) => env.pi.thread(id).archived,
            ),
          '停止后连带归档',
        )
      } finally {
        await env.close()
      }
    })
  }
}

test('延迟归档 self：承诺后新增的活跃子会话在回合结束时仍阻止归档', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    await env.pi.callTool(threadId, 'litch_sessions', 'archive', { thread_id: 'self' })
    const child = await startChild(
      env.device.sessionTree,
      threadId,
      {
        title: '晚到的子会话',
        prompt: '验收',
        kind: 'fresh',
        wakeParent: false,
        worktree: false,
      },
      'user',
    )
    // 同步等待归档回调的检查完成，避免用固定延时判“没发生”。
    const check = env.device.archives.assertChildrenStopped.bind(env.device.archives)
    let checked = false
    env.device.archives.assertChildrenStopped = async (id) => {
      try {
        await check(id)
      } finally {
        if (id === threadId) checked = true
      }
    }
    env.pi.end(threadId)
    await until(() => checked, '延迟归档重新检查后代')
    assert.equal(Boolean(env.pi.thread(threadId).archived), false)
    assert.equal(env.pi.running(child.threadId), true)
  } finally {
    await env.close()
  }
})
