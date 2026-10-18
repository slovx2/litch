// 任务库本身：触发键防重复、运行记录只留最近 200 条；定时器最长等 5 分钟；任务跑出来的会话归进工作区。
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import test from 'node:test'
import type { DeviceTaskRun } from '../../protocol/src/device-tasks.mjs'
import { MAX_TIMER_MS } from '../src/task-scheduler.mjs'
import { openTaskDatabase, TASK_RUNS_KEPT, TaskStore } from '../src/task-store.mjs'
import { tempDir } from './helpers.mjs'
import { intervalTask, TaskEngine, taskRig, tasksClient, until } from './task-kit.mjs'

const MINUTE = 60_000

function run(id: string, status: DeviceTaskRun['status'] = 'succeeded'): DeviceTaskRun {
  return {
    id,
    taskId: 't1',
    trigger: 'scheduled',
    scheduledFor: 1,
    coalesced: 0,
    status,
    harness: 'pi',
    threadId: null,
    turnId: null,
    startedAt: null,
    finishedAt: null,
    summary: null,
    error: null,
    read: false,
  }
}

test('触发键用过了不再记；每个任务的运行记录只留最近 200 条，没结束的不删', () => {
  const dir = tempDir()
  const store = new TaskStore(openTaskDatabase(dir))
  try {
    assert.equal(store.insertRun(run('a'), 't1:1:100'), true)
    assert.equal(store.insertRun(run('b'), 't1:1:100'), false)
    assert.equal(store.run('b'), null)
    store.insertRun(run('live', 'running'), null)
    for (let index = 0; index < TASK_RUNS_KEPT + 5; index++) store.insertRun(run(`r${index}`), null)
    store.prune('t1')
    const kept = store.runs({ taskId: 't1', limit: 1000, before: null })
    assert.equal(kept.filter((item) => item.status === 'succeeded').length, TASK_RUNS_KEPT)
    assert.ok(
      kept.some((item) => item.id === 'live'),
      '没结束的不删',
    )
    assert.equal(store.run('a'), null, '最早的删了')
    assert.ok(store.run(`r${TASK_RUNS_KEPT + 4}`))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('定时器最长等 5 分钟就醒来看一眼墙钟；任务跑出来的会话归进指定的工作区', async () => {
  const engine = new TaskEngine()
  const target = taskRig({ pi: engine })
  try {
    const client = await tasksClient(target)
    const workspace = target.connect()
    await workspace.initialize(['harness', 'deviceWorkspaces', 'deviceTasks'])
    const project = (
      await workspace.call('project/create', {
        name: '应用',
        roots: [{ path: target.stateDir }],
        idempotencyKey: 'k-app',
      })
    ).project
    const { task } = await client.call(
      'litch/task/create',
      intervalTask(target.stateDir, 60, {
        target: {
          kind: 'newThread',
          harness: 'pi',
          cwd: target.stateDir,
          workspaceId: project.id,
          settings: { model: null, effort: null, permission: null },
        },
      }),
    )
    const [first] = target.clock.pending()
    assert.ok(first !== undefined && first <= MAX_TIMER_MS, `定时器等了 ${first} 毫秒`)
    // 醒来时还没到点：不跑，接着定时
    target.clock.advance(MAX_TIMER_MS)
    assert.equal(engine.turns.length, 0)
    assert.equal(target.clock.pending().length, 1)
    target.clock.advance(60 * MINUTE)
    await until('跑完', async () => {
      const runs = (await client.call('litch/task/runs/list', {})).data
      return runs[0]?.status === 'succeeded'
    })
    const threadId = engine.turns[0]?.threadId
    const moved = await workspace.waitFor(
      (frame) =>
        frame.method === 'thread/project/updated' && (frame.params as any).threadId === threadId,
    )
    assert.equal((moved.params as any).projectId, project.id)
    const read = await workspace.call('thread/read', { threadId })
    assert.equal(read.thread.projectId, project.id)
    assert.ok(task.id)
  } finally {
    await target.close()
  }
})
