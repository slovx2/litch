import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { startChild } from '../src/session-start.mjs'
import { RpcFailure } from './fake-upstream.mjs'
import { intervalTask } from './task-kit.mjs'
import { parent, treeRig, until } from './tree-kit.mjs'

test('定时任务以普通会话、活动经理、工作线为目标：原会话恢复并完成；归档恢复失败沿用暂停规则', async () => {
  const env = treeRig()
  try {
    const client = env.connect()
    await client.initialize(['harness', 'litchManager', 'deviceTasks', 'sessionTree'])
    const { manager, threadId } = await client.call(MANAGER_METHOD.create, {
      cwd: env.stateDir,
      harness: 'pi',
      model: null,
      effort: null,
      name: '定时经理',
      scope: '验证定时目标',
      template: 'blank',
      rules: '',
      firstTask: '',
      dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false },
      contact: { ...MANAGER_DEFAULT_CONTACT },
    })
    await until(() => env.pi.running(threadId), '经理开场')
    env.pi.end(threadId, 'completed', '等待任务')
    await until(() => !env.device.sessionTree.isActive(threadId), '经理空闲')
    const line = await startChild(
      env.device.sessionTree,
      threadId,
      {
        kind: 'fresh',
        title: '定时工作线',
        prompt: '准备',
        wakeParent: false,
        worktree: false,
      },
      'model',
    )
    env.pi.end(line.threadId, 'completed', '准备好了')
    await until(() => !env.device.sessionTree.isActive(line.threadId), '工作线空闲')
    const ordinary = await parent(client, false)
    const targets = [ordinary.threadId, threadId, line.threadId]
    assert.equal(env.device.managers?.manager(manager.id).status, 'active')
    assert.equal(env.device.managers?.lines.mark(line.threadId)?.role, 'line')
    const tasks: string[] = []
    for (const id of targets) {
      const created = await client.call(
        'litch/task/create',
        intervalTask(env.stateDir, 5, {
          target: { kind: 'thread', harness: 'pi', threadId: id },
        }),
      )
      tasks.push(created.task.id)
      const { run } = await client.call('litch/task/runNow', { id: created.task.id })
      await until(() => env.pi.running(id), '定时回合启动')
      const input = JSON.stringify(env.pi.current(id)?.items)
      assert.match(input, /Scheduled task run/)
      assert.ok(
        env.pi.seen.some(
          (request) => request.method === 'thread/resume' && request.params.threadId === id,
        ),
      )
      env.pi.end(id, 'completed', '定时执行完成')
      await until(async () => {
        const result = await client.call('litch/task/runs/list', { taskId: created.task.id })
        return result.data.some(
          (entry: any) =>
            entry.id === run.id && entry.status === 'succeeded' && entry.threadId === id,
        )
      }, '原会话的任务运行成功')
    }
    // 模拟引擎拒绝恢复归档线程：各身份都走普通任务的 threadMissing → 暂停，不另起线程。
    const resume = env.pi.handlers['thread/resume']
    assert.ok(resume)
    env.pi.handlers['thread/resume'] = (params, connection) => {
      if (env.pi.thread(params.threadId).archived)
        throw new RpcFailure(-32600, 'Thread is archived')
      return resume(params, connection)
    }
    for (const [index, id] of targets.entries()) {
      await client.call('thread/archive', { threadId: id })
      await client.call('litch/task/runNow', { id: tasks[index] })
      await until(async () => {
        const list = await client.call('litch/task/list', {})
        const task = list.data.find((entry: any) => entry.id === tasks[index])
        return task.status === 'paused' && task.lastError?.code === 'threadMissing'
      }, '归档目标恢复失败后任务暂停')
      assert.equal(env.pi.running(id), false)
    }
  } finally {
    await env.close()
  }
})
