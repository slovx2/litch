// 定时任务一次运行的几种失败，以及设置（总开关、并发上限）和忙不忙：
// harness 不可用、目录不存在、会话没了（任务暂停）、回合失败、超时打断、一次性任务跑完 completed。
import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { FakeControl, managed } from './fake-control.mjs'
import { settle, type TestClient } from './helpers.mjs'
import { intervalTask, TaskEngine, taskRig, tasksClient, until } from './task-kit.mjs'

const MINUTE = 60_000

async function lastRun(client: TestClient): Promise<any> {
  return (await client.call('litch/task/runs/list', {})).data[0]
}

async function finished(client: TestClient): Promise<any> {
  await until('跑完', async () => {
    const run = await lastRun(client)
    return run !== undefined && ['succeeded', 'failed'].includes(run.status)
  })
  return lastRun(client)
}

async function taskOf(client: TestClient, id: string): Promise<any> {
  return (await client.call('litch/task/list', {})).data.find((item: any) => item.id === id)
}

test('harness 连不上：这次失败 harnessUnavailable，任务不暂停，lastError 记着；之后成功一次清掉', async () => {
  const engine = new TaskEngine()
  const target = taskRig({ pi: engine }, { tasks: { timing: { harnessWaitMs: 50 } } })
  try {
    const client = await tasksClient(target)
    const { task } = await client.call('litch/task/create', intervalTask(target.stateDir))
    engine.down = true
    target.clock.advance(5 * MINUTE)
    const run = await finished(client)
    assert.equal(run.status, 'failed')
    assert.equal(run.error.code, 'harnessUnavailable')
    let now = await taskOf(client, task.id)
    assert.equal(now.status, 'active')
    assert.equal(now.lastError.code, 'harnessUnavailable')
    engine.down = false
    await client.call('litch/task/runNow', { id: task.id })
    await until('成功', async () => (await lastRun(client)).status === 'succeeded')
    now = await taskOf(client, task.id)
    assert.equal(now.lastError, null)
  } finally {
    await target.close()
  }
})

test('主进程说 harness 停用了：当场失败，不去连', async () => {
  const engine = new TaskEngine()
  const control = new FakeControl([managed('pi', 'disabled')])
  const target = taskRig(
    {},
    { control, dial: () => engine.connector, tasks: { timing: { harnessWaitMs: 10_000 } } },
  )
  try {
    const client = await tasksClient(target)
    const { task } = await client.call('litch/task/create', intervalTask(target.stateDir))
    const started = Date.now()
    await client.call('litch/task/runNow', { id: task.id })
    const run = await finished(client)
    assert.equal(run.error.code, 'harnessUnavailable')
    assert.ok(Date.now() - started < 5000, '停用了的不该等')
  } finally {
    await target.close()
  }
})

test('工作目录不存在：cwdMissing；会话没了：threadMissing，任务暂停', async () => {
  const engine = new TaskEngine()
  engine.threads.push({ id: 'pi-old', updatedAt: 1 })
  const target = taskRig({ pi: engine })
  try {
    const client = await tasksClient(target)
    const { task: lost } = await client.call(
      'litch/task/create',
      intervalTask(join(target.stateDir, 'gone')),
    )
    await client.call('litch/task/runNow', { id: lost.id })
    assert.equal((await finished(client)).error.code, 'cwdMissing')
    assert.equal((await taskOf(client, lost.id)).status, 'active')

    const { task } = await client.call('litch/task/create', {
      ...intervalTask(target.stateDir),
      target: { kind: 'thread', harness: 'pi', threadId: 'pi-old' },
    })
    engine.threads = engine.threads.filter((thread) => thread.id !== 'pi-old')
    await client.call('litch/task/runNow', { id: task.id })
    await until('第二次跑完', async () => (await lastRun(client)).taskId === task.id)
    const run = await finished(client)
    assert.equal(run.error.code, 'threadMissing')
    const paused = await taskOf(client, task.id)
    assert.equal(paused.status, 'paused')
    assert.equal(paused.nextRunAt, null)
    assert.equal(paused.revision, 2)
  } finally {
    await target.close()
  }
})

test('thread 目标：在已有会话里接着发；会话正忙就等它空下来', async () => {
  const engine = new TaskEngine()
  engine.threads.push({ id: 'pi-busy', updatedAt: 1, status: { type: 'active', activeFlags: [] } })
  const target = taskRig({ pi: engine })
  try {
    const client = await tasksClient(target)
    const { task } = await client.call('litch/task/create', {
      ...intervalTask(target.stateDir),
      target: { kind: 'thread', harness: 'pi', threadId: 'pi-busy' },
    })
    await client.call('litch/task/runNow', { id: task.id })
    await until('恢复了会话', () => engine.seen.some((item) => item.method === 'thread/resume'))
    await settle(50)
    assert.equal(engine.turns.length, 0, '会话忙着时不发回合')
    assert.equal((await lastRun(client)).status, 'queued')
    const thread = engine.threads.find((item) => item.id === 'pi-busy')
    if (thread) thread.status = { type: 'idle' }
    engine.notify('thread/status/changed', { threadId: 'pi-busy', status: { type: 'idle' } })
    const run = await finished(client)
    assert.equal(run.status, 'succeeded')
    assert.equal(run.threadId, 'pi-busy')
    assert.equal(engine.turns[0]?.threadId, 'pi-busy')
  } finally {
    await target.close()
  }
})

test('回合失败记 turnFailed；超过时限打断，记 timedOut', async () => {
  const engine = new TaskEngine()
  engine.script = () => ({ status: 'failed' })
  const target = taskRig({ pi: engine }, { tasks: { timing: { turnTimeoutMs: 300 } } })
  try {
    const client = await tasksClient(target)
    const { task } = await client.call('litch/task/create', intervalTask(target.stateDir))
    await client.call('litch/task/runNow', { id: task.id })
    const failed = await finished(client)
    assert.equal(failed.error.code, 'turnFailed')
    assert.match(failed.error.message, /模型出错了/)
    engine.script = () => ({ status: null })
    await client.call('litch/task/runNow', { id: task.id })
    await until('第二次', async () => (await lastRun(client)).id !== failed.id)
    const timed = await finished(client)
    assert.equal(timed.error.code, 'timedOut')
    assert.ok(engine.seen.some((item) => item.method === 'turn/interrupt'))
  } finally {
    await target.close()
  }
})

test('一次性任务：到点跑一次，跑完 completed，不再排', async () => {
  const engine = new TaskEngine()
  const target = taskRig({ pi: engine })
  try {
    const client = await tasksClient(target)
    // 两小时后（上海时间）
    const at = new Date(target.clock.now() + 2 * 60 * MINUTE + MINUTE)
    const local = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai',
      dateStyle: 'short',
      timeStyle: 'short',
    })
      .format(at)
      .replace(' ', 'T')
    const { task } = await client.call(
      'litch/task/create',
      intervalTask(target.stateDir, 5, { schedule: { type: 'once', at: local } }),
    )
    assert.ok(task.nextRunAt > task.createdAt)
    target.clock.advance(3 * 60 * MINUTE)
    const run = await finished(client)
    assert.equal(run.status, 'succeeded')
    const done = await taskOf(client, task.id)
    assert.equal(done.status, 'completed')
    assert.equal(done.nextRunAt, null)
    assert.deepEqual(target.clock.pending(), [])
  } finally {
    await target.close()
  }
})

test('设置：总开关关着不按日程跑，再打开时错过的不补；并发上限当场换；在跑的任务算忙', async () => {
  const engine = new TaskEngine()
  engine.script = () => ({ status: null })
  const control = new FakeControl([managed('pi')])
  control.tasks = { enabled: false, maxConcurrent: 1 }
  control.push()
  const target = taskRig({}, { control, dial: () => engine.connector })
  try {
    const client = await tasksClient(target)
    const { task } = await client.call('litch/task/create', intervalTask(target.stateDir))
    assert.deepEqual(target.clock.pending(), [], '关着时不定时')
    target.clock.advance(12 * MINUTE)
    await settle(50)
    assert.equal(engine.turns.length, 0)
    control.taskSettings({ enabled: true })
    await settle(20)
    // 错过的 5、10 分钟不补，下一次是 15 分钟
    assert.equal((await taskOf(client, task.id)).nextRunAt, task.createdAt + 15 * 60)
    assert.equal(engine.turns.length, 0)
    // 并发上限 1：两个一起到点只跑一个
    const second = (await client.call('litch/task/create', intervalTask(target.stateDir))).task
    await client.call('litch/task/runNow', { id: task.id })
    await client.call('litch/task/runNow', { id: second.id })
    await until('一个在跑', () => engine.turns.length === 1)
    await settle(50)
    assert.equal(engine.turns.length, 1)
    const busy = (await control.ask('activity')) as any
    assert.equal(busy.tasks, 1)
    control.taskSettings({ maxConcurrent: 2 })
    await until('第二个也开始', () => engine.turns.length === 2)
    for (const turn of engine.turns) engine.finish(turn, 'completed', '好')
    await until('都跑完', async () => {
      const runs = (await client.call('litch/task/runs/list', {})).data
      return runs.every((run: any) => run.status === 'succeeded')
    })
    assert.equal(((await control.ask('activity')) as any).tasks, 0)
  } finally {
    await target.close()
  }
})
