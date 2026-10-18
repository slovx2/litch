// 定时任务（deviceTasks 扩展）：核心对着假的聚合面（fake-device.mts）和假的任务接口（fake-tasks.mts）跑。
// 守的是这几条：握手声明、看设备的 extensions 决定能不能用（不能用时的降级）、对账只在连上和重连时做、
// 通知是唯一的来源、冲突带最新的任务、会话上的“定时”记号、打开会话算看过、建会话时带不带 litch_tasks、
// litch_tasks 的调用万一到了桌面端回失败不弹卡片。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JsonRpcMessage } from '../../protocol/src/index.mjs'
import {
  type ChannelError,
  connectChannel,
  createCore,
  createPortPair,
  createReplica,
  keys,
  type SessionSummary,
  type SidebarOp,
  type SidebarView,
  serveChannel,
  type TaskRunsPage,
  type TasksOp,
  type TasksView,
  type TaskView,
} from '../src/index.mjs'
import { type FakeHarness, fakeDevice, harness } from './fake-device.mjs'
import { fakeOpener } from './fake-server.mjs'
import { fakeTasks, rawRun, rawTask } from './fake-tasks.mjs'
import { thread, turn } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'

const never = { aborted: false, addEventListener() {} }

const engines = (): FakeHarness[] => [
  harness('pi', {
    threads: [
      thread({ id: 'p1', updatedAt: 1_700_000_400, turns: [turn('pt1', [])] }),
      thread({ id: 'p2', updatedAt: 1_700_000_300 }),
      thread({ id: 'p3', updatedAt: 1_700_000_200 }),
    ],
  }),
  harness('dsh', {
    threads: [],
    declaration: { extensions: [], features: {}, permissionPresets: [] } as never,
  }),
]

function world(extensions: string[] = ['harness', 'deviceTasks']) {
  const fake = fakeDevice(engines())
  fake.device.extensions = extensions
  const tasks = fakeTasks()
  const peer = fakeOpener({ ...fake.handlers, ...tasks.handlers })
  const time = fakeClock()
  const core = createCore({
    clock: time.clock,
    version: '9.9.9',
    log: () => {},
    devices: [
      {
        id: 'local',
        name: '本机',
        host: 'dev@mac',
        kind: 'local',
        target: null,
        wire: 'green',
        open: peer.open,
      },
    ],
  })
  const rows = new Map<string, SessionSummary>()
  core.subscribe(
    { kind: 'sidebar', deviceId: 'local' },
    {
      snapshot(data) {
        rows.clear()
        for (const entry of (data as SidebarView).sessions) rows.set(entry.id, entry)
      },
      delta(ops) {
        for (const op of ops as SidebarOp[]) {
          if (op.op === 'session.upsert') rows.set(op.session.id, op.session)
          else if (op.op === 'session.remove') rows.delete(op.sessionId)
        }
      },
      error() {},
    },
  )
  /** 像界面那样订阅 tasks 主题，快照和增量都记下来 */
  const watch = () => {
    const seen = { snapshots: [] as TasksView[], ops: [] as TasksOp[] }
    const close = core.subscribe(
      { kind: 'tasks', deviceId: 'local' },
      {
        snapshot: (data) => seen.snapshots.push(structuredClone(data as TasksView)),
        delta: (ops) => seen.ops.push(...structuredClone(ops as TasksOp[])),
        error() {},
      },
    )
    return { seen, close }
  }
  const command = (name: string, params: object = {}) =>
    core.command(name, { deviceId: 'local', ...params }, never)
  /** 像设备服务那样，把通知发给每一条连接 */
  const broadcast = (method: string, params: unknown) => {
    for (const server of peer.servers) server.notify(method, params)
  }
  const sent = (method: string) =>
    peer.servers
      .flatMap((server) => server.seen)
      .filter((entry) => entry.method === method)
      .map((entry) => entry.params as Record<string, unknown>)
  return {
    fake: fake.device,
    tasks: tasks.state,
    peer,
    time,
    core,
    rows,
    watch,
    command,
    broadcast,
    sent,
  }
}

async function failureOf(run: Promise<unknown>): Promise<ChannelError> {
  try {
    await run
  } catch (error) {
    return error as ChannelError
  }
  throw new Error('这条命令本该失败')
}

/** 等对账：连上之后几趟往返 */
const settled = async () => {
  for (let round = 0; round < 6; round++) await settle()
}

test('握手时声明 deviceTasks；设备列了它：对账取任务和最近的运行，快照 available 为真、时间换成毫秒', async () => {
  const w = world()
  w.tasks.tasks.push(
    rawTask('a', { createdAt: 1_700_000_010 }),
    rawTask('b', { createdAt: 1_700_000_005, status: 'paused', nextRunAt: null }),
  )
  const { seen } = w.watch()
  // 还没连上：照样有快照，不知道支不支持
  assert.equal(seen.snapshots[0]?.available, null)
  w.core.start()
  await settled()
  const init = w.peer.last().seen.find((entry) => entry.method === 'initialize')?.params as {
    capabilities: { litchExtensions: string[] }
  }
  assert.ok(init.capabilities.litchExtensions.includes('deviceTasks'))
  const last = seen.snapshots.at(-1)
  assert.equal(last?.available, true)
  // 按建的先后
  assert.deepEqual(
    last?.tasks.map((task) => task.id),
    ['b', 'a'],
  )
  assert.equal(last?.tasks[1]?.nextRunAt, 1_700_050_000_000)
  assert.equal(last?.tasks[1]?.deviceId, 'local')
  assert.equal(w.sent('litch/task/list').length, 1)
  assert.equal(w.sent('litch/task/runs/list')[0]?.limit, 200)
})

test('设备没列 deviceTasks：available 为假，命令以 unsupported 结束、说得出是哪一句，不去调任务的方法；建会话不带 litch_tasks', async () => {
  const w = world(['harness'])
  const { seen } = w.watch()
  w.core.start()
  await settled()
  assert.equal(seen.snapshots.at(-1)?.available, false)
  const failure = await failureOf(w.command('tasks.runNow', { taskId: 'a' }))
  assert.equal(failure.code, 'unsupported')
  assert.equal(failure.text?.key, 'tasks.unsupported')
  assert.equal(
    w.peer.servers
      .flatMap((server) => server.seen)
      .some((entry) => entry.method.startsWith('litch/task/')),
    false,
  )
  await w.command('session.create', { harness: 'pi', cwd: '/work', text: '你好' })
  const start = w.sent('thread/start').at(-1) as { dynamicTools?: { name: string }[] }
  assert.ok(!(start.dynamicTools ?? []).some((entry) => entry.name === 'litch_tasks'))
})

test('建会话：设备列了 deviceTasks 就带上 litch_tasks（这台桌面什么都执行不了也带）；声明了不收客户端工具的 harness 不带', async () => {
  const w = world()
  w.core.start()
  await settled()
  await w.command('session.create', { harness: 'pi', cwd: '/work', text: '你好' })
  const start = w.sent('thread/start').at(-1) as { dynamicTools?: { name: string; type: string }[] }
  assert.deepEqual(
    start.dynamicTools?.map((entry) => [entry.type, entry.name]),
    [['namespace', 'litch_tasks']],
  )
  // 握手时没有声明能执行它：执行方是设备
  const init = w.peer.last().seen.find((entry) => entry.method === 'initialize')?.params as {
    capabilities: { litchExtensions: string[]; litchClientTools?: unknown }
  }
  assert.ok(!init.capabilities.litchExtensions.includes('clientTools'))
  assert.equal(init.capabilities.litchClientTools, undefined)
  await w.command('session.create', { harness: 'dsh', cwd: '/work', text: '你好' })
  const plain = w.sent('thread/start').at(-1) as { dynamicTools?: unknown }
  assert.equal(plain.dynamicTools, undefined)
})

test('litch_tasks 的调用到了桌面端（本不该发生）：回失败，不弹卡片', async () => {
  const w = world()
  w.core.start()
  await settled()
  const reply = (await w.peer.last().ask('item/tool/call', {
    threadId: 'p1',
    turnId: 'pt1',
    callId: 'c1',
    namespace: 'litch_tasks',
    tool: 'list',
    arguments: {},
  })) as JsonRpcMessage & { result?: { success: boolean } }
  assert.equal(reply.result?.success, false)
  assert.equal(w.rows.get('p1')?.status === 'waiting', false)
})

test('通知是唯一的来源：任务多了、变了、没了照着改；旧版本的通知不要；不轮询', async () => {
  const w = world()
  w.tasks.tasks.push(rawTask('a', { revision: 2 }))
  const { seen } = w.watch()
  w.core.start()
  await settled()
  w.broadcast('litch/task/changed', {
    change: 'created',
    taskId: 'c',
    task: rawTask('c', { createdAt: 1_700_000_500 }),
  })
  w.broadcast('litch/task/changed', {
    change: 'updated',
    taskId: 'a',
    task: rawTask('a', { revision: 3, name: '改了名' }),
  })
  // 迟到的旧版本
  w.broadcast('litch/task/changed', {
    change: 'updated',
    taskId: 'a',
    task: rawTask('a', { revision: 1 }),
  })
  w.broadcast('litch/task/changed', { change: 'deleted', taskId: 'c', task: null })
  await settled()
  assert.deepEqual(
    seen.ops.map((op) =>
      op.op === 'task.remove'
        ? `-${op.taskId}`
        : op.op === 'task.upsert'
          ? `${op.task.id}:${op.task.name}`
          : op.op,
    ),
    ['c:任务 c', 'a:改了名', '-c'],
  )
  w.time.advance(10 * 60_000)
  await settled()
  assert.equal(w.sent('litch/task/list').length, 1)
})

test('运行的通知：看着它结束的标 finished；标成看过了、对账补上的都不标', async () => {
  const w = world()
  w.tasks.tasks.push(rawTask('a'))
  const { seen } = w.watch()
  w.core.start()
  await settled()
  const run = (fields: object) => ({ run: rawRun('r1', 'a', { threadId: 'p2', ...fields }) })
  w.broadcast('litch/task/run/changed', run({ status: 'running', finishedAt: null }))
  w.broadcast('litch/task/run/changed', run({ status: 'failed', read: false }))
  w.broadcast('litch/task/run/changed', run({ status: 'failed', read: true }))
  // 很快就跑完、头一次见到就是结束了的也算
  w.broadcast('litch/task/run/changed', {
    run: rawRun('r2', 'a', { status: 'succeeded', read: false }),
  })
  // 删掉了的任务的运行不要
  w.broadcast('litch/task/run/changed', {
    run: rawRun('r9', 'gone', { status: 'succeeded', read: false }),
  })
  await settled()
  const runs = seen.ops.filter((op) => op.op === 'run.upsert')
  assert.deepEqual(
    runs.map((op) => (op.op === 'run.upsert' ? [op.run.id, op.run.status, op.finished] : null)),
    [
      ['r1', 'running', false],
      ['r1', 'failed', true],
      ['r1', 'failed', false],
      ['r2', 'succeeded', true],
    ],
  )
})

test('会话上的记号：任务的目标会话是 target，运行跑出来的是 run（最近的那一次），变了侧栏那一行跟着换', async () => {
  const w = world()
  w.tasks.tasks.push(
    rawTask('watch', { target: { kind: 'thread', harness: 'pi', threadId: 'p1' } }),
    rawTask('daily'),
  )
  w.tasks.runs.push(
    rawRun('r2', 'daily', { threadId: 'p2', scheduledFor: 1_700_000_900 }),
    rawRun('r1', 'daily', { threadId: 'p2', scheduledFor: 1_700_000_100 }),
    rawRun('r0', 'watch', { threadId: 'p1' }),
  )
  w.core.start()
  await settled()
  assert.deepEqual(w.rows.get('p1')?.task, { kind: 'target', taskId: 'watch' })
  assert.deepEqual(w.rows.get('p2')?.task, {
    kind: 'run',
    taskId: 'daily',
    runId: 'r2',
    trigger: 'scheduled',
    scheduledFor: 1_700_000_900_000,
  })
  assert.equal(w.rows.get('p3')?.task, null)
  // p3 里跑了一次
  w.broadcast('litch/task/run/changed', {
    run: rawRun('r3', 'daily', { threadId: 'p3', status: 'running' }),
  })
  await settled()
  assert.equal(w.rows.get('p3')?.task?.kind, 'run')
  // 任务删了：记号都没了
  w.broadcast('litch/task/changed', { change: 'deleted', taskId: 'daily', task: null })
  await settled()
  assert.equal(w.rows.get('p2')?.task, null)
  assert.equal(w.rows.get('p3')?.task, null)
})

test('打开任务跑出来的会话：里面跑完、没看过的运行标成看过了，任务的未读数先跟着减', async () => {
  const w = world()
  w.tasks.tasks.push(rawTask('daily', { unreadRuns: 2 }))
  w.tasks.runs.push(
    rawRun('r2', 'daily', { threadId: 'p1', read: false }),
    rawRun('r1', 'daily', { threadId: 'p2', read: false }),
  )
  const { seen } = w.watch()
  w.core.start()
  await settled()
  const close = w.core.subscribe(
    { kind: 'session', deviceId: 'local', sessionId: 'p1' },
    { snapshot() {}, delta() {}, error() {} },
  )
  await settled()
  assert.deepEqual(w.sent('litch/task/runs/markRead'), [{ runIds: ['r2'] }])
  const task = seen.ops.findLast((op) => op.op === 'task.upsert')
  assert.equal(task?.op === 'task.upsert' ? task.task.unreadRuns : null, 1)
  close()
})

test('改任务：版本对不上以 conflict 结束，带来的最新任务先发出去；字段不对以 invalid 结束、key 是哪个字段；暂停撞上冲突自己再试一次', async () => {
  const w = world()
  w.tasks.tasks.push(rawTask('a', { revision: 4, name: '别处改的' }))
  const { seen } = w.watch()
  w.core.start()
  await settled()
  // 设备上又被改了一次，这边还没收到通知
  const remote = w.tasks.tasks[0]
  assert.ok(remote)
  remote.revision = 5
  const conflict = await failureOf(
    w.command('tasks.update', { taskId: 'a', revision: 4, patch: { name: '我改的' } }),
  )
  assert.equal(conflict.code, 'conflict')
  assert.equal(conflict.text?.key, 'tasks.conflict')
  const latest = seen.ops.findLast((op) => op.op === 'task.upsert')
  assert.equal(latest?.op === 'task.upsert' ? latest.task.revision : null, 5)

  const invalid = await failureOf(
    w.command('tasks.create', {
      task: {
        name: '',
        prompt: 'x',
        schedule: { type: 'daily', time: '09:00' },
        timezone: null,
        target: rawTask('z').target,
      },
    }),
  )
  assert.equal(invalid.code, 'invalid')
  assert.equal(invalid.key, 'name')

  const gone = await failureOf(w.command('tasks.delete', { taskId: 'nope' }))
  assert.equal(gone.code, 'notFound')

  // 暂停：按手上最新的版本改；再被别处改一次也能成
  remote.revision = 9
  const paused = (await w.command('tasks.pause', { taskId: 'a', paused: true })) as {
    task: TaskView
  }
  assert.equal(paused.task.status, 'paused')
  assert.equal(paused.task.revision, 10)
})

test('新建、立即运行（重复的不另起）、删除：成了之后不等通知先发出去', async () => {
  const w = world()
  const { seen } = w.watch()
  w.core.start()
  await settled()
  const created = (await w.command('tasks.create', {
    task: {
      name: '新任务',
      prompt: '看看',
      schedule: { type: 'daily', time: '09:00' },
      timezone: null,
      target: rawTask('z').target,
    },
  })) as { task: TaskView }
  assert.equal(created.task.name, '新任务')
  assert.equal(w.sent('litch/task/create')[0]?.timezone, undefined)
  const first = (await w.command('tasks.runNow', { taskId: created.task.id })) as {
    deduplicated: boolean
  }
  const again = (await w.command('tasks.runNow', { taskId: created.task.id })) as {
    deduplicated: boolean
  }
  assert.deepEqual([first.deduplicated, again.deduplicated], [false, true])
  await w.command('tasks.delete', { taskId: created.task.id })
  assert.deepEqual(
    seen.ops.map((op) => op.op),
    ['task.upsert', 'run.upsert', 'run.upsert', 'task.remove'],
  )
})

test('重连之后重新对账：断开期间的变化靠这一次补上；断开时手上的那份留着', async () => {
  const w = world()
  w.tasks.tasks.push(rawTask('a'))
  const { seen } = w.watch()
  w.core.start()
  await settled()
  w.tasks.tasks.push(rawTask('b', { createdAt: 1_700_000_900 }))
  w.peer.last().drop()
  await settled()
  // 断开：没有新的快照，手上的不清
  const before = seen.snapshots.length
  w.time.advance(60_000)
  await settled()
  assert.ok(seen.snapshots.length > before)
  assert.deepEqual(
    seen.snapshots.at(-1)?.tasks.map((task) => task.id),
    ['a', 'b'],
  )
  assert.equal(w.sent('litch/task/list').length, 2)
})

test('数据副本：未读合计、按设备的任务键；打开运行记录取头一页、往下翻、运行变了跟着换', async () => {
  const w = world()
  w.tasks.pageSize = 2
  w.tasks.tasks.push(
    rawTask('a', { unreadRuns: 2 }),
    rawTask('b', { unreadRuns: 1, createdAt: 1_700_000_500 }),
  )
  for (let n = 5; n >= 1; n--)
    w.tasks.runs.push(rawRun(`r${n}`, 'a', { scheduledFor: 1_700_000_000 + n }))
  const [ui, coreSide] = createPortPair()
  serveChannel(coreSide, w.core, { clock: w.time.clock, frameMs: 0 })
  const replica = createReplica(connectChannel(ui))
  replica.start()
  w.core.start()
  await settled()
  w.time.advance(1)
  await settled()
  assert.equal(replica.store.get<number>(keys.tasksUnread), 3)
  assert.deepEqual(replica.store.get<string[]>(keys.taskIds('local')), ['a', 'b'])
  assert.equal(replica.store.get<boolean>(keys.tasksAvailable('local')), true)
  const close = replica.openTaskRuns('local', 'a')
  await settled()
  w.time.advance(1)
  await settled()
  let page = replica.store.get<TaskRunsPage>(keys.taskRuns('local', 'a'))
  assert.deepEqual(
    page?.runs.map((run) => run.id),
    ['r5', 'r4'],
  )
  replica.moreTaskRuns('local', 'a')
  await settled()
  w.time.advance(1)
  await settled()
  page = replica.store.get<TaskRunsPage>(keys.taskRuns('local', 'a'))
  assert.deepEqual(
    page?.runs.map((run) => run.id),
    ['r5', 'r4', 'r3', 'r2'],
  )
  const finished: string[] = []
  replica.onTaskRunFinished((run, task) => finished.push(`${run.id}:${task?.name}`))
  w.broadcast('litch/task/run/changed', {
    run: rawRun('r6', 'a', { status: 'failed', read: false }),
  })
  await settled()
  w.time.advance(1)
  await settled()
  page = replica.store.get<TaskRunsPage>(keys.taskRuns('local', 'a'))
  assert.equal(page?.runs[0]?.id, 'r6')
  assert.deepEqual(finished, ['r6:任务 a'])
  close()
  assert.equal(replica.store.get(keys.taskRuns('local', 'a')), undefined)
})
