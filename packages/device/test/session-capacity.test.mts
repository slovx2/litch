// 并发保护必须覆盖建会话和复用会话，且经理设置优先。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { reserveSessionWork } from '../src/session-capacity.mjs'
import { startChild } from '../src/session-start.mjs'
import { brief, parent, treeRig, until } from './tree-kit.mjs'

const spec = {
  kind: 'fresh' as const,
  title: '工作线',
  prompt: '工作',
  wakeParent: false,
  worktree: false,
}

async function setup(env: ReturnType<typeof treeRig>, managerLimit: number | null) {
  const client = env.connect()
  await client.initialize(['harness', 'sessionTree', 'litchManager', 'clientTools'])
  let threadId: string
  if (managerLimit === null) ({ threadId } = await parent(client))
  else {
    const created = await client.call(MANAGER_METHOD.create, {
      cwd: env.stateDir,
      harness: 'pi',
      model: null,
      effort: null,
      name: '经理',
      scope: '测试',
      template: 'blank',
      rules: '',
      firstTask: '',
      dispatch: { ...MANAGER_DEFAULT_DISPATCH, maxRunningLines: managerLimit, worktree: false },
      contact: { ...MANAGER_DEFAULT_CONTACT },
    })
    threadId = created.threadId
    await until(() => env.pi.running(threadId), '经理开场')
  }
  return { client, threadId }
}

for (const managerLimit of [null, 10, 25]) {
  test(`并发保护：${managerLimit === null ? '普通会话默认 8' : `经理配置 ${managerLimit}`}，start、send、恢复后开回合共用名额`, async () => {
    const env = treeRig()
    try {
      const { client, threadId } = await setup(env, managerLimit)
      const tree = env.device.sessionTree
      const limit = managerLimit ?? 8
      const lines: string[] = []
      for (let i = 0; i < limit - 1; i++)
        lines.push((await startChild(tree, threadId, spec, 'user')).threadId)
      const toolStart = async () => {
        const result = await env.pi.callTool(threadId, 'litch_sessions', 'start', {
          initiation: 'user_asked',
          title: '最后一位',
          worktree: false,
          ...brief('工作'),
        })
        assert.ok(result)
        return result.answer.result
      }
      const last = await toolStart()
      assert.equal(last.success, true, JSON.stringify(last))
      lines.push(JSON.parse(last.contentItems[0].text).thread_id)
      assert.equal(lines.length, limit)
      const error =
        managerLimit === null
          ? /Direct child capacity: 8/
          : new RegExp(`Manager workline capacity: ${limit}.*limit ${limit}`)
      await assert.rejects(startChild(tree, threadId, spec, 'user'), error)
      assert.match((await toolStart()).contentItems[0].text, error)
      const idle = lines[0]
      const second = lines[1]
      assert.ok(idle && second)
      env.pi.end(idle)
      await until(() => !tree.isActive(idle), '首条工作线结束')
      // 另起一条补满；仅恢复历史不会占槽，真正开新回合才检查。
      await startChild(tree, threadId, spec, 'user')
      await client.call('thread/resume', { threadId: idle })
      const blocked = await client.fails('turn/start', {
        threadId: idle,
        input: [{ type: 'text', text: '继续' }],
      })
      assert.match(blocked.message, error)
      const send = async (target = idle) => {
        const result = await env.pi.callTool(threadId, 'litch_sessions', 'send', {
          thread_id: target,
          message: '继续',
        })
        assert.ok(result)
        return result.answer.result
      }
      assert.match((await send()).contentItems[0].text, error)
      assert.equal(env.pi.running(idle), false)
      // 已运行的工作线继续收插话，不占第二个槽。
      assert.equal((await send(second)).success, true)
      env.pi.end(second)
      await until(() => !tree.isActive(second), '释放一位')
      assert.equal((await send()).success, true)
      assert.equal(env.pi.running(idle), true)
      await assert.rejects(startChild(tree, threadId, spec, 'user'), error)
      env.pi.end(idle)
      await until(() => !tree.isActive(idle), '再次释放一位')
      // send 和 start 同时抢最后一个槽，不能各自算完都放行。
      const outcomes = await Promise.allSettled([
        startChild(tree, threadId, spec, 'user'),
        send().then((result) => assert.equal(result.success, true)),
      ])
      assert.equal(outcomes.filter((one) => one.status === 'fulfilled').length, 1)
    } finally {
      await env.close()
    }
  })
}

for (const managerLimit of [null, 8]) {
  for (const state of ['waiting', 'background', 'continuation'] as const) {
    test(`并发计数：${managerLimit === null ? '普通' : '经理'} ${state} 占槽、空闲释放，现有工作不重复计数`, async () => {
      const env = treeRig()
      try {
        const { threadId } = await setup(env, managerLimit)
        const tree = env.device.sessionTree
        const lines = []
        for (let i = 0; i < 8; i++)
          lines.push((await startChild(tree, threadId, spec, 'user')).threadId)
        const target = lines[0]
        assert.ok(target)
        env.pi.end(target)
        await until(() => !tree.isActive(target), '目标空闲')
        const originalRead = env.pi.handlers['thread/read']
        assert.ok(originalRead)
        if (state === 'waiting') {
          env.pi.handlers['thread/read'] = async (params, connection) => {
            const result = (await originalRead(params, connection)) as {
              thread: { status: unknown }
            }
            if (params.threadId === target)
              result.thread.status = { type: 'idle', activeFlags: ['waitingOnUserInput'] }
            return result
          }
          env.device.managers.lines.snapshots.set(target, {
            status: { type: 'idle', activeFlags: ['waitingOnUserInput'] },
          })
        } else if (state === 'background') {
          env.device.background.reportedChanged({
            threadId: target,
            tasks: [{ id: 'bg', kind: 'shell', title: '后台', status: 'running' }],
            wakesOnFinish: false,
          })
        } else tree.host.continuationPending = (id) => id === target
        assert.equal(tree.occupiesSlot(target), true)
        await assert.rejects(
          startChild(tree, threadId, spec, 'user'),
          managerLimit === null ? /Direct child capacity: 8/ : /Manager workline capacity: 8/,
        )
        const hold = await reserveSessionWork(tree, target, target)
        hold.release()
        env.pi.handlers['thread/read'] = originalRead
        env.device.managers.lines.snapshots.delete(target)
        env.device.background.reportedChanged({ threadId: target, tasks: [], wakesOnFinish: false })
        tree.host.continuationPending = () => false
        assert.equal(tree.occupiesSlot(target), false)
        await startChild(tree, threadId, spec, 'user')
      } finally {
        await env.close()
      }
    })
  }
}

test('普通会话树：24 槽包括根，恢复根回合也不能绕过整树上限', async () => {
  const env = treeRig()
  try {
    const { client, threadId } = await setup(env, null)
    const tree = env.device.sessionTree
    const first = await startChild(tree, threadId, spec, 'user')
    const second = await startChild(tree, threadId, spec, 'user')
    for (let i = 0; i < 6; i++) await startChild(tree, threadId, spec, 'user')
    for (let i = 0; i < 8; i++) await startChild(tree, first.threadId, spec, 'user')
    for (let i = 0; i < 7; i++) await startChild(tree, second.threadId, spec, 'user')
    await assert.rejects(
      startChild(tree, second.threadId, spec, 'user'),
      /Session tree capacity: 24/,
    )
    env.pi.end(threadId)
    await until(() => !tree.isActive(threadId), '根回合结束')
    const last = await startChild(tree, second.threadId, spec, 'user')
    const blocked = await client.fails('turn/start', {
      threadId,
      input: [{ type: 'text', text: '继续' }],
    })
    assert.match(blocked.message, /Session tree capacity: 24/)
    env.pi.end(last.threadId)
    await until(() => !tree.isActive(last.threadId), '释放根的一位')
    await client.call('turn/start', { threadId, input: [{ type: 'text', text: '继续' }] })
  } finally {
    await env.close()
  }
})

test('经理：已建成但首回合失败的工作线继续占槽，恢复该线不重复占槽', async () => {
  const env = treeRig()
  try {
    const { client, threadId } = await setup(env, 1)
    const tree = env.device.sessionTree
    const startTurn = env.pi.handlers['turn/start']
    assert.ok(startTurn)
    env.pi.handlers['turn/start'] = () => {
      throw new Error('首回合失败')
    }
    await assert.rejects(startChild(tree, threadId, spec, 'user'), /start was not confirmed/)
    env.pi.handlers['turn/start'] = startTurn
    await assert.rejects(startChild(tree, threadId, spec, 'user'), /Manager workline capacity: 1/)
    const child = tree.store.childrenOf(threadId)[0]
    assert.ok(child)
    await client.call('turn/start', {
      threadId: child.threadId,
      input: [{ type: 'text', text: '重试' }],
    })
    assert.equal(env.pi.running(child.threadId), true)
    assert.equal(tree.store.childStarts().length, 0)
  } finally {
    await env.close()
  }
})
