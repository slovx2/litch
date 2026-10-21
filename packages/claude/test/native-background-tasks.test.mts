import assert from 'node:assert/strict'
import test from 'node:test'
import { BackgroundTaskTracker } from '../src/background-tasks.mjs'
import {
  backgroundBash,
  disposeScene,
  readTurns,
  runTurn,
  type Scene,
  say,
  startScene,
  uniqueSleep,
  until,
} from './fixtures/background-scene.mjs'

// 后台任务的集合（backgroundTasks 扩展）：模拟的 SDK 消息喂给集合；真的 CLI 跑一条后台命令看线上的样子

const level = (tasks: Array<Record<string, unknown>>) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks,
})
const ended = (taskId: string, status: string) => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: taskId,
  status,
})

test('BG-001 集合：成员看电平信号，状态看结束通知，种类按任务类型', () => {
  let clock = 1_000
  const tracker = new BackgroundTaskTracker(() => clock)
  // task_started 先到也行：来历先记着，电平信号列进来才算在跑
  tracker.apply(
    't',
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 'b1',
      tool_use_id: 'tu1',
      task_type: 'local_bash',
      description: 'npm run dev',
    },
    'turn-1',
  )
  assert.deepEqual(tracker.list('t'), [])
  clock = 2_000
  assert.equal(
    tracker.apply(
      't',
      level([
        { task_id: 'b1', task_type: 'local_bash', description: 'npm run dev' },
        { task_id: 'm1', task_type: 'local_bash', shell_kind: 'monitor', description: '盯日志' },
        { task_id: 'm2', task_type: 'monitor_mcp', description: 'PR 检查' },
        { task_id: 'a1', task_type: 'local_agent', description: '查资料' },
        { task_id: 'w1', task_type: 'local_workflow', description: '审代码' },
        { task_id: 'r1', task_type: 'remote_agent', description: '云端会话' },
        { task_id: 'x1', task_type: 'monitor_ws', description: '后台观察', ambient: true },
        { task_id: 'd1', task_type: 'dream', description: '整理记忆' },
      ]),
      'turn-1',
    ),
    true,
  )
  const kinds = Object.fromEntries(tracker.list('t').map((task) => [task.id, task.kind]))
  assert.deepEqual(kinds, {
    b1: 'shell',
    m1: 'monitor',
    m2: 'monitor',
    a1: 'agent',
    w1: 'workflow',
    r1: 'remote',
  })
  const shell = tracker.list('t').find((task) => task.id === 'b1')
  assert.deepEqual(shell, {
    id: 'b1',
    kind: 'shell',
    title: 'npm run dev',
    status: 'running',
    turnId: 'turn-1',
    startedAt: 1_000,
  })
  // 后台命令登记进来：挂回命令条目，标题用命令本身
  assert.equal(
    tracker.link('t', 'b1', {
      itemId: 'item-1',
      turnId: 'turn-1',
      command: 'npm run dev -- --port 5173',
    }),
    true,
  )
  assert.equal(tracker.list('t').find((task) => task.id === 'b1')?.itemId, 'item-1')
  assert.equal(
    tracker.list('t').find((task) => task.id === 'b1')?.title,
    'npm run dev -- --port 5173',
  )

  // 电平信号先把它收掉（先按完成算），结束通知再说是失败的
  clock = 5_000
  tracker.apply(
    't',
    level([
      { task_id: 'm1', task_type: 'local_bash', shell_kind: 'monitor', description: '盯日志' },
      { task_id: 'm2', task_type: 'monitor_mcp', description: 'PR 检查' },
      { task_id: 'a1', task_type: 'local_agent', description: '查资料' },
      { task_id: 'w1', task_type: 'local_workflow', description: '审代码' },
      { task_id: 'r1', task_type: 'remote_agent', description: '云端会话' },
    ]),
    null,
  )
  assert.equal(tracker.list('t').find((task) => task.id === 'b1')?.status, 'completed')
  assert.equal(tracker.apply('t', ended('b1', 'failed'), null), true)
  // 结束通知先到、电平信号后到也是同一个结局
  assert.equal(tracker.apply('t', ended('a1', 'stopped'), null), true)
  const listed = tracker.list('t')
  assert.equal(listed.find((task) => task.id === 'b1')?.status, 'failed')
  assert.equal(listed.find((task) => task.id === 'b1')?.endedAt, 5_000)
  assert.equal(listed.find((task) => task.id === 'a1')?.status, 'stopped')
  // 运行中的在前（按开始时间），结束过的在后
  assert.deepEqual(
    listed.map((task) => task.status),
    ['running', 'running', 'running', 'running', 'failed', 'stopped'],
  )

  // CLI 进程退出：还在跑的都停了
  clock = 9_000
  assert.equal(tracker.closeAll('t'), true)
  assert.ok(tracker.list('t').every((task) => task.status !== 'running'))
  assert.equal(tracker.closeAll('t'), false)
})

test('BG-002 结束过的最多留 50 个', () => {
  let clock = 0
  const tracker = new BackgroundTaskTracker(() => clock)
  for (let index = 0; index < 60; index++) {
    clock++
    tracker.apply(
      't',
      level([{ task_id: `b${index}`, task_type: 'local_bash', description: `c${index}` }]),
      null,
    )
  }
  clock++
  tracker.apply('t', level([]), null)
  const listed = tracker.list('t')
  assert.equal(listed.length, 50)
  // 结束得晚的在前
  assert.equal(listed[0]?.id, 'b59')
})

const declaring = { litchExtensions: ['backgroundTasks'] }

// 声明了扩展的连接看到的会话对象、回合多出我们的字段：校验上游结构时去掉
function standardView(method: string, _kind: string, payload: any): unknown {
  if (method.startsWith('litch/')) return undefined
  const copy = structuredClone(payload)
  const strip = (thread: any) => {
    if (!thread || typeof thread !== 'object') return
    delete thread.litchBackground
    for (const turn of thread.turns ?? []) delete turn.litchOrigin
  }
  strip(copy?.thread)
  for (const entry of copy?.data ?? []) {
    strip(entry)
    delete entry?.litchOrigin
  }
  delete copy?.turn?.litchOrigin
  return copy
}

const backgroundChanges = (scene: Scene): any[] =>
  scene.client.trace
    .filter((message) => message.method === 'litch/thread/background/changed')
    .map((message) => message.params)

test('BG-003 后台命令：集合挂在会话上、变了就发通知，续跑的回合带来历', {
  timeout: 120_000,
}, async () => {
  const scene = await startScene('native-bg-tasks', {}, declaring)
  scene.client.standardView = standardView
  const command = uniqueSleep(2)
  try {
    scene.model.enqueue(backgroundBash('toolu_bgtask', command))
    scene.model.enqueue(say('已在后台启动'))
    scene.model.fallback = () => [{ type: 'text', text: '命令结束了' }]
    await runTurn(scene, '在后台启动一条短命令')

    const read = await scene.client.request('thread/read', { threadId: scene.threadId })
    const running = read.thread.litchBackground
    assert.equal(running?.wakesOnFinish, true)
    assert.equal(running.tasks.length, 1)
    const [task] = running.tasks
    assert.equal(task.kind, 'shell')
    assert.equal(task.status, 'running')
    assert.equal(task.title, command)
    const turns = await readTurns(scene)
    const item = turns[0].items.find((entry: any) => entry.type === 'commandExecution')
    assert.equal(task.itemId, item.id, '任务挂回发起它的命令条目')
    assert.equal(task.turnId, turns[0].id)
    assert.ok(
      backgroundChanges(scene).some((change) =>
        change.tasks.some((one: any) => one.status === 'running'),
      ),
    )

    // 命令结束：集合里记成完成，CLI 自己续跑的那一轮带 litchOrigin
    await until('任务结束', () =>
      backgroundChanges(scene).some((change) =>
        change.tasks.some((one: any) => one.id === task.id && one.status === 'completed'),
      ),
    )
    await until(
      '续跑的回合结束',
      () => scene.client.trace.filter((message) => message.method === 'turn/completed').length >= 2,
      60_000,
    )
    const started = scene.client.trace.filter((message) => message.method === 'turn/started')
    assert.equal(started[0].params.turn.litchOrigin, undefined, '用户的回合不带')
    assert.equal(started[1].params.turn.litchOrigin, 'backgroundTask')
    const history = await readTurns(scene)
    assert.equal(history[1].litchOrigin, 'backgroundTask')
    const page = await scene.client.request('thread/turns/list', { threadId: scene.threadId })
    assert.ok(page.data.some((turn: any) => turn.litchOrigin === 'backgroundTask'))
    const ended = (await scene.client.request('thread/read', { threadId: scene.threadId })).thread
      .litchBackground
    assert.equal(ended.tasks[0].status, 'completed')
    assert.ok(ended.tasks[0].endedAt >= ended.tasks[0].startedAt)
  } finally {
    await disposeScene(scene)
  }
})

test('BG-004 没声明的连接：只有原生表示', { timeout: 120_000 }, async () => {
  const scene = await startScene('native-bg-plain')
  const command = uniqueSleep(2)
  try {
    scene.model.enqueue(backgroundBash('toolu_bgplain', command))
    scene.model.enqueue(say('已在后台启动'))
    scene.model.fallback = () => [{ type: 'text', text: '命令结束了' }]
    await runTurn(scene, '在后台启动一条短命令')
    const read = await scene.client.request('thread/read', {
      threadId: scene.threadId,
      includeTurns: true,
    })
    assert.equal(read.thread.litchBackground, undefined)
    await until(
      '续跑的回合结束',
      () => scene.client.trace.filter((message) => message.method === 'turn/completed').length >= 2,
      60_000,
    )
    assert.equal(backgroundChanges(scene).length, 0)
    for (const message of scene.client.trace)
      if (message.method === 'turn/started' || message.method === 'turn/completed')
        assert.equal(message.params.turn.litchOrigin, undefined)
    for (const turn of await readTurns(scene)) assert.equal(turn.litchOrigin, undefined)
  } finally {
    await disposeScene(scene)
  }
})
