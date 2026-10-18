// 定时任务的方法和通知（deviceTasks 扩展）：声明、增删改查、校验、冲突、上限、运行记录的分页和已读。
import assert from 'node:assert/strict'
import test from 'node:test'
import { TASK_LIMIT } from '../../protocol/src/device-tasks.mjs'
import { assertErrorData, errorCode, settle, tempDir } from './helpers.mjs'
import {
  assertNotification,
  assertParams,
  assertResponse,
  assertTaskErrorData,
  intervalTask,
  TaskEngine,
  taskErrorCode,
  taskRig,
  tasksClient,
  until,
} from './task-kit.mjs'

test('没声明 deviceTasks 的连接调任务方法回 extensionRequired，收不到任务的通知；设备信息里列着 deviceTasks', async () => {
  const engine = new TaskEngine()
  const target = taskRig({ pi: engine })
  try {
    const plain = target.connect()
    await plain.initialize()
    const info = await plain.call('runtime/info')
    assert.ok(info.device.extensions.includes('deviceTasks'))
    const failure = await plain.fails('litch/task/list', {})
    assert.equal(failure.code, errorCode('extensionRequired'))
    assert.deepEqual(failure.data.required, ['deviceTasks'])
    assertErrorData(failure.data)
    const declared = await tasksClient(target)
    await declared.call('litch/task/create', intervalTask(target.stateDir))
    await settle()
    assert.equal(
      plain.notifications.some((frame) => String(frame.method).startsWith('litch/task/')),
      false,
    )
    assert.ok(declared.notifications.some((frame) => frame.method === 'litch/task/changed'))
  } finally {
    await target.close()
  }
})

test('新建、列出、修改、删除：形状照扩展定义，revision 对不上回 taskConflict，变化发给声明过的每条连接', async () => {
  const engine = new TaskEngine()
  const target = taskRig({ pi: engine })
  try {
    const one = await tasksClient(target)
    const two = await tasksClient(target)
    const params = intervalTask(target.stateDir)
    assertParams('litch/task/create', params)
    const created = await one.call('litch/task/create', params)
    assertResponse('litch/task/create', created)
    const task = created.task
    assert.equal(task.status, 'active')
    assert.equal(task.revision, 1)
    assert.deepEqual(task.origin, { kind: 'client' })
    assert.equal(task.nextRunAt, task.createdAt + 300)
    assert.equal(task.lastRun, null)
    assert.equal(task.unreadRuns, 0)
    for (const client of [one, two]) {
      const changed = await client.waitFor((frame) => frame.method === 'litch/task/changed')
      assertNotification('litch/task/changed', changed.params)
      assert.equal((changed.params as any).change, 'created')
    }
    const listed = await two.call('litch/task/list', {})
    assertResponse('litch/task/list', listed)
    assert.deepEqual(
      listed.data.map((item: any) => item.id),
      [task.id],
    )

    const update = { id: task.id, revision: 1, name: '周报', status: 'paused' }
    assertParams('litch/task/update', update)
    const updated = await one.call('litch/task/update', update)
    assertResponse('litch/task/update', updated)
    assert.equal(updated.task.name, '周报')
    assert.equal(updated.task.revision, 2)
    assert.equal(updated.task.nextRunAt, null)

    const stale = await two.fails('litch/task/update', { id: task.id, revision: 1, name: 'x' })
    assert.equal(stale.code, taskErrorCode('taskConflict'))
    assertTaskErrorData(stale.data)
    assert.equal(stale.data.litch, 'taskConflict')
    assert.equal(stale.data.task.revision, 2)

    // 改回 active：从现在往后算
    const resumed = await one.call('litch/task/update', {
      id: task.id,
      revision: 2,
      status: 'active',
    })
    assert.ok(resumed.task.nextRunAt > resumed.task.updatedAt)
    // newThread 只能改 cwd、workspaceId、settings
    const harness = await one.fails('litch/task/update', {
      id: task.id,
      revision: 3,
      target: { harness: 'pi-b' },
    })
    assert.equal(harness.data.litch, 'invalidTask')
    assert.equal(harness.data.field, 'target.harness')
    const retargeted = await one.call('litch/task/update', {
      id: task.id,
      revision: 3,
      target: { settings: { model: 'gate', effort: 'high', permission: null } },
    })
    assert.equal(retargeted.task.target.settings.model, 'gate')
    assert.equal(retargeted.task.target.cwd, target.stateDir)

    const deleted = await one.call('litch/task/delete', { id: task.id })
    assertResponse('litch/task/delete', deleted)
    const gone = await two.waitFor(
      (frame) =>
        frame.method === 'litch/task/changed' && (frame.params as any).change === 'deleted',
    )
    assertNotification('litch/task/changed', gone.params)
    assert.equal((gone.params as any).task, null)
    const unknown = await one.fails('litch/task/runNow', { id: task.id })
    assert.equal(unknown.code, taskErrorCode('unknownTask'))
    assert.equal(unknown.data.litch, 'unknownTask')
    assert.deepEqual((await one.call('litch/task/list', {})).data, [])
  } finally {
    await target.close()
  }
})

test('字段不对回 invalidTask，target 不对回 invalidTarget，都说是哪个字段', async () => {
  const engine = new TaskEngine()
  engine.threads.push({ id: 'pi-old', updatedAt: 1 })
  const target = taskRig({ pi: engine })
  try {
    const client = await tasksClient(target)
    const base = intervalTask(target.stateDir)
    const cases: [Record<string, unknown>, string, string][] = [
      [{ name: '' }, 'invalidTask', 'name'],
      [{ name: 'x'.repeat(121) }, 'invalidTask', 'name'],
      [{ prompt: '   ' }, 'invalidTask', 'prompt'],
      [{ schedule: { type: 'interval', minutes: 1 } }, 'invalidTask', 'schedule.minutes'],
      [{ timezone: 'Mars/Olympus' }, 'invalidTask', 'timezone'],
      [{ target: { ...base.target, harness: 'nope' } }, 'invalidTarget', 'target.harness'],
      [{ target: { ...base.target, cwd: 'relative/path' } }, 'invalidTask', 'target.cwd'],
      [
        { target: { ...base.target, workspaceId: 'no-such' } },
        'invalidTarget',
        'target.workspaceId',
      ],
      [
        { target: { kind: 'thread', harness: 'pi', threadId: 'missing' } },
        'invalidTarget',
        'target.threadId',
      ],
      [{ target: { kind: 'other', harness: 'pi' } }, 'invalidTask', 'target.kind'],
      [{ schedule: { type: 'once', at: '2001-01-01T09:00' } }, 'invalidTask', 'schedule'],
    ]
    for (const [change, reason, field] of cases) {
      const failure = await client.fails('litch/task/create', { ...base, ...change })
      assert.equal(failure.data.litch, reason, JSON.stringify(change))
      assert.equal(failure.code, taskErrorCode(reason))
      assert.equal(failure.data.field, field, JSON.stringify(change))
      assertTaskErrorData(failure.data)
    }
    // thread 目标的会话索引里没有时问一下引擎
    const ok = await client.call('litch/task/create', {
      ...base,
      target: { kind: 'thread', harness: 'pi', threadId: 'pi-old' },
    })
    assert.deepEqual(ok.task.target, { kind: 'thread', harness: 'pi', threadId: 'pi-old' })
  } finally {
    await target.close()
  }
})

test(`一台设备最多 ${TASK_LIMIT} 个任务，到了回 taskLimitReached`, async () => {
  const target = taskRig({ pi: new TaskEngine() })
  try {
    const client = await tasksClient(target)
    const base = intervalTask(target.stateDir, 60, { status: 'paused' })
    for (let index = 0; index < TASK_LIMIT; index++)
      await client.call('litch/task/create', { ...base, name: `任务 ${index}` })
    const failure = await client.fails('litch/task/create', base)
    assert.equal(failure.code, taskErrorCode('taskLimitReached'))
    assert.equal(failure.data.litch, 'taskLimitReached')
  } finally {
    await target.close()
  }
})

test('运行记录新的在前、按游标翻页；markRead 标看过，任务上的未读数跟着变', async () => {
  const engine = new TaskEngine()
  const target = taskRig({ pi: engine })
  try {
    const client = await tasksClient(target)
    const { task } = await client.call(
      'litch/task/create',
      intervalTask(target.stateDir, 60, { status: 'paused' }),
    )
    const runs: string[] = []
    for (let index = 0; index < 5; index++) {
      const now = await client.call('litch/task/runNow', { id: task.id })
      assertResponse('litch/task/runNow', now)
      assert.equal(now.deduplicated, false)
      runs.push(now.run.id)
      await until('这次跑完', async () => {
        const page = await client.call('litch/task/runs/list', { taskId: task.id, limit: 1 })
        return page.data[0]?.status === 'succeeded'
      })
    }
    const first = await client.call('litch/task/runs/list', { taskId: task.id, limit: 2 })
    assertResponse('litch/task/runs/list', first)
    assert.deepEqual(
      first.data.map((run: any) => run.id),
      [runs[4], runs[3]],
    )
    assert.ok(first.nextCursor)
    const second = await client.call('litch/task/runs/list', {
      taskId: task.id,
      limit: 2,
      cursor: first.nextCursor,
    })
    assert.deepEqual(
      second.data.map((run: any) => run.id),
      [runs[2], runs[1]],
    )
    const last = await client.call('litch/task/runs/list', { cursor: second.nextCursor })
    assert.deepEqual(
      last.data.map((run: any) => run.id),
      [runs[0]],
    )
    assert.equal(last.nextCursor, null)
    const bad = await client.fails('litch/task/runs/list', { cursor: 'abc' })
    assert.equal(bad.data.field, 'cursor')

    let listed = (await client.call('litch/task/list', {})).data[0]
    assert.equal(listed.unreadRuns, 5)
    assert.equal(listed.lastRun.id, runs[4])
    assert.equal(listed.lastRun.read, false)
    await client.call('litch/task/runs/markRead', { runIds: [runs[0], runs[1]] })
    listed = (await client.call('litch/task/list', {})).data[0]
    assert.equal(listed.unreadRuns, 3)
    const read = await client.waitFor(
      (frame) => frame.method === 'litch/task/run/changed' && (frame.params as any).run.read,
    )
    assertNotification('litch/task/run/changed', read.params)
    const marked = await client.call('litch/task/runs/markRead', { taskId: task.id })
    assertResponse('litch/task/runs/markRead', marked)
    listed = (await client.call('litch/task/list', {})).data[0]
    assert.equal(listed.unreadRuns, 0)
  } finally {
    await target.close()
  }
})

test('任务库带迁移：重新打开时任务和运行记录都在；比这一版新的库不碰，设备上不列 deviceTasks', async () => {
  const stateDir = tempDir()
  const first = taskRig({ pi: new TaskEngine() }, { stateDir })
  const client = await tasksClient(first)
  const { task } = await client.call(
    'litch/task/create',
    intervalTask(stateDir, 60, { status: 'paused' }),
  )
  await first.device.close()
  const { DatabaseSync } = await import('node:sqlite')
  const { join } = await import('node:path')
  const { statSync } = await import('node:fs')
  const path = join(stateDir, 'tasks.sqlite')
  assert.equal(statSync(path).mode & 0o777, 0o600)
  const second = taskRig({ pi: new TaskEngine() }, { stateDir })
  try {
    const again = await tasksClient(second)
    const listed = await again.call('litch/task/list', {})
    assert.deepEqual(
      listed.data.map((item: any) => item.id),
      [task.id],
    )
  } finally {
    await second.device.close()
  }
  const db = new DatabaseSync(path)
  db.exec('PRAGMA user_version=99')
  db.close()
  const third = taskRig({ pi: new TaskEngine() }, { stateDir })
  try {
    const client = third.connect()
    await client.initialize(['harness', 'deviceTasks'])
    const info = await client.call('runtime/info')
    assert.equal(info.device.extensions.includes('deviceTasks'), false)
    const failure = await client.fails('litch/task/list', {})
    assert.equal(failure.data.litch, 'unsupported')
  } finally {
    await third.close()
  }
})
