import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { lastUserText, say, uniqueSleep, until } from './fixtures/background-scene.mjs'
import { claudeCliCommand } from './fixtures/claude-cli.mjs'
import { Daemon, type DaemonClient } from './fixtures/daemon.mjs'
import { deferred } from './fixtures/deferred.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { descendants, killAll, processTable } from './fixtures/process-tree.mjs'

interface Scene {
  home: string
  workspace: string
  model: MockLLM
  modelUrl: string
  daemon: Daemon
  // 建线程的那条连接。
  first: DaemonClient
  threadId: string
}

// 一个监听 WebSocket 的适配器、一个回环模型、一个写文件要确认的线程。
// 连接可以断开再连，用来造出“没有客户端在看”。
async function startScene(name: string, env: Record<string, string> = {}): Promise<Scene> {
  const home = await mkdtemp(join(tmpdir(), `${name}-`))
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  const model = new MockLLM()
  const modelUrl = await model.start()
  const daemon = await Daemon.start(home, modelUrl, env)
  const first = await daemon.connect('first')
  const { thread } = await first.request('thread/start', {
    cwd: workspace,
    approvalPolicy: 'on-request',
    sandbox: 'danger-full-access',
  })
  return { home, workspace, model, modelUrl, daemon, first, threadId: thread.id }
}

async function dispose(scene: Scene): Promise<void> {
  const tree = descendants(scene.daemon.process.pid as number).map((row) => row.pid)
  await scene.daemon.close()
  await scene.model.close()
  killAll(tree)
  await rm(scene.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

const writeFile = (path: string) => () => [
  {
    type: 'tool_use',
    id: 'toolu_write',
    name: 'Write',
    input: { file_path: path, content: 'WRITTEN\n' },
  },
]

const cliProcesses = (scene: Scene) =>
  descendants(scene.daemon.process.pid as number).filter((row) =>
    row.command.startsWith(claudeCliCommand()),
  )

const alive = (command: string): boolean =>
  processTable().some((row) => row.command.includes(command) && !row.command.includes('/bin/ps'))

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function readThread(client: DaemonClient, threadId: string): Promise<any> {
  return (await client.request('thread/read', { threadId, includeTurns: true })).thread
}

// 让线程停在“CLI 自己续跑的一轮要写文件、却没有客户端在看”上：先跑一个带后台命令的回合，
// 断开唯一的连接；短命令结束后 CLI 自己开一轮，模型在这一轮里写文件。
// keep 是另一条一直在跑的后台命令，用来看进程有没有被收掉。返回连接断开的时刻。
async function strandOnApproval(scene: Scene, target: string, keep?: string): Promise<number> {
  const commands = [uniqueSleep(4), ...(keep ? [keep] : [])]
  scene.model.enqueue(() =>
    commands.map((command, index) => ({
      type: 'tool_use',
      id: `toolu_bg_${index}`,
      name: 'Bash',
      input: { command, run_in_background: true, description: 'background command' },
    })),
  )
  scene.model.enqueue(say('已在后台启动'))
  scene.model.enqueue((request) => {
    assert.match(lastUserText(request), /task-notification/)
    return writeFile(target)()
  })
  const { turn } = await scene.first.request('turn/start', {
    threadId: scene.threadId,
    input: [{ type: 'text', text: '在后台启动命令' }],
  })
  assert.equal((await scene.first.completed(turn.id)).status, 'completed')
  await scene.first.disconnect()
  const disconnectedAt = Date.now()
  await until('通知触发的那一轮向模型发出请求', () => scene.model.requests.length === 3, 30_000)
  // 没有人能确认：回合停在这里，既不执行也不当作拒绝告诉模型。
  await pause(1_500)
  assert.equal(scene.model.requests.length, 3, '没有客户端在看时不应把确认当作拒绝')
  assert.equal(await exists(target), false)
  return disconnectedAt
}

const waitingStatus = { type: 'active', activeFlags: ['waitingOnApproval'] }

test('没有客户端在看时自行续跑的回合遇到确认：回合停住；客户端连上并订阅后收到请求，同意后继续', {
  timeout: 120_000,
}, async () => {
  const scene = await startScene('unattended-accept')
  const target = join(scene.workspace, 'approved.txt')
  try {
    await strandOnApproval(scene, target)

    // 新连接一握手就被告知这个线程在等人；没订阅之前收不到确认请求。
    const client = await scene.daemon.connect('second')
    const announced = await client.notification(
      'thread/status/changed',
      (params) => params.threadId === scene.threadId,
    )
    assert.deepEqual(announced.status, waitingStatus)
    const before = await readThread(client, scene.threadId)
    assert.deepEqual(before.status, waitingStatus)
    assert.deepEqual(
      before.turns.map((turn: any) => turn.status),
      ['completed', 'inProgress'],
    )
    assert.equal(client.serverRequests.length, 0)

    scene.model.enqueue(say('已经写好'))
    const resumed = await client.request('thread/resume', { threadId: scene.threadId })
    assert.deepEqual(resumed.thread.status, waitingStatus)
    const request = await client.serverRequest('item/fileChange/requestApproval')
    assert.equal(request.params.turnId, before.turns[1].id, '请求属于停在那里的那个回合')
    const order = client.trace.map((message) => message.method ?? `response:${message.id}`)
    assert.ok(
      order.indexOf('item/fileChange/requestApproval') >
        order.findLastIndex((entry) => entry.startsWith('response:')),
      '确认请求在恢复线程的应答之后送达',
    )

    client.answer(request, { decision: 'accept' })
    assert.equal((await client.completed(before.turns[1].id)).status, 'completed')
    assert.equal(await readFile(target, 'utf8'), 'WRITTEN\n')
    await client.notification('serverRequest/resolved', (params) => params.requestId === request.id)
    const after = await readThread(client, scene.threadId)
    assert.deepEqual(after.status, { type: 'idle' })
    assert.match(JSON.stringify(after.turns[1].items), /已经写好/)
    scene.model.assertConsumed()
  } finally {
    await dispose(scene)
  }
})

test('没有客户端在看时停住的确认：之后拒绝，模型得知被拒绝并收尾，文件没有写', {
  timeout: 120_000,
}, async () => {
  const scene = await startScene('unattended-decline')
  const target = join(scene.workspace, 'declined.txt')
  try {
    await strandOnApproval(scene, target)
    const client = await scene.daemon.connect('second')
    scene.model.enqueue((request) => {
      assert.match(lastUserText(request), /denied by user/)
      return [{ type: 'text', text: '没有写成' }]
    })
    await client.request('thread/resume', { threadId: scene.threadId })
    const request = await client.serverRequest('item/fileChange/requestApproval')
    client.answer(request, { decision: 'decline' })
    assert.equal((await client.completed(request.params.turnId)).status, 'completed')
    assert.equal(await exists(target), false)
    const thread = await readThread(client, scene.threadId)
    assert.match(JSON.stringify(thread.turns[1].items), /没有写成/)
    scene.model.assertConsumed()
  } finally {
    await dispose(scene)
  }
})

test('停在确认上的回合被打断：请求作废，回合记为中断，不留进程', { timeout: 120_000 }, async () => {
  const scene = await startScene('unattended-interrupt')
  const target = join(scene.workspace, 'interrupted.txt')
  try {
    await strandOnApproval(scene, target)
    assert.equal(cliProcesses(scene).length, 1, '回合停着时进程还在')
    const client = await scene.daemon.connect('second')
    const waiting = (await readThread(client, scene.threadId)).turns[1]
    await client.request('turn/interrupt', { threadId: scene.threadId, turnId: waiting.id })
    assert.equal((await client.completed(waiting.id)).status, 'interrupted')
    await until('进程退出', () => cliProcesses(scene).length === 0)
    await pause(1_000)
    assert.equal(client.serverRequests.length, 0, '作废的请求不再送给后来的连接')
    assert.equal(scene.model.requests.length, 3)
    assert.equal(await exists(target), false)
    assert.deepEqual((await readThread(client, scene.threadId)).status, { type: 'idle' })
  } finally {
    await dispose(scene)
  }
})

test('停在确认上时适配器退出：不留进程，重启后那个回合已经收尾', { timeout: 120_000 }, async () => {
  const scene = await startScene('unattended-exit')
  const target = join(scene.workspace, 'exit.txt')
  const long = uniqueSleep(120)
  try {
    await strandOnApproval(scene, target, long)
    const pids = cliProcesses(scene).map((row) => row.pid)
    assert.equal(pids.length, 1)
    assert.equal(alive(long), true)

    await scene.daemon.close()
    await until('后台命令随适配器退出', () => !alive(long), 10_000)
    assert.equal(
      processTable().some((row) => pids.includes(row.pid)),
      false,
      'CLI 进程不应留下',
    )

    scene.daemon = await Daemon.start(scene.home, scene.modelUrl)
    const client = await scene.daemon.connect('after-restart')
    const thread = await readThread(client, scene.threadId)
    assert.notEqual(thread.turns[1].status, 'inProgress')
    assert.notEqual(thread.status.type, 'active')
    assert.equal(client.serverRequests.length, 0)
    assert.equal(await exists(target), false)
  } finally {
    await dispose(scene)
  }
})

test('停在确认上时全部连接断开超过保留时间：进程与回合都留着；回答之后再断开才回收', {
  timeout: 150_000,
}, async () => {
  // 保留 9 秒：比“短命令结束、回合停到确认上”晚，回收检查时回合已经在等人。
  const lingerMs = 9_000
  const scene = await startScene('unattended-linger', {
    CHA_CLAUDE_KEEP_ALIVE_DETACHED_MINUTES: String(lingerMs / 60_000),
  })
  const target = join(scene.workspace, 'linger.txt')
  const long = uniqueSleep(120)
  try {
    const disconnectedAt = await strandOnApproval(scene, target, long)
    await pause(Math.max(0, disconnectedAt + lingerMs + 2_000 - Date.now()))
    assert.equal(cliProcesses(scene).length, 1, '等人确认的回合占着进程，到点不回收')
    assert.equal(alive(long), true)

    const client = await scene.daemon.connect('second')
    scene.model.enqueue(say('已经写好'))
    await client.request('thread/resume', { threadId: scene.threadId })
    const request = await client.serverRequest('item/fileChange/requestApproval')
    client.answer(request, { decision: 'accept' })
    assert.equal((await client.completed(request.params.turnId)).status, 'completed')
    assert.equal(await readFile(target, 'utf8'), 'WRITTEN\n')
    assert.equal(alive(long), true, '回合结束后后台命令照常留着')

    // 回合结束了：再次全部断开后，保留时间照常起作用。
    await client.disconnect()
    await until('保留时间过后进程与后台命令被回收', () => !alive(long), lingerMs + 15_000)
    await until('CLI 进程退出', () => cliProcesses(scene).length === 0)
  } finally {
    await dispose(scene)
  }
})

test('用户回合里确认请求已经送达、客户端随后断开：请求不作废，新连接订阅后原样重发', {
  timeout: 120_000,
}, async () => {
  const scene = await startScene('unattended-user-sent')
  const target = join(scene.workspace, 'resent.txt')
  try {
    scene.model.enqueue(writeFile(target))
    const { turn } = await scene.first.request('turn/start', {
      threadId: scene.threadId,
      input: [{ type: 'text', text: '写一个文件' }],
    })
    const original = await scene.first.serverRequest('item/fileChange/requestApproval')
    await scene.first.disconnect()
    await pause(1_500)
    assert.equal(scene.model.requests.length, 1, '断开连接不等于拒绝')

    const client = await scene.daemon.connect('second')
    const announced = await client.notification(
      'thread/status/changed',
      (params) => params.threadId === scene.threadId,
    )
    assert.deepEqual(announced.status, waitingStatus)
    scene.model.enqueue(say('已经写好'))
    await client.request('thread/resume', { threadId: scene.threadId })
    const replayed = await client.serverRequest('item/fileChange/requestApproval')
    assert.deepEqual(
      { id: replayed.id, params: replayed.params },
      { id: original.id, params: original.params },
      '重发的请求与原来的一样，请求 ID 不变',
    )
    client.answer(replayed, { decision: 'accept' })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    assert.equal(await readFile(target, 'utf8'), 'WRITTEN\n')
    scene.model.assertConsumed()
  } finally {
    await dispose(scene)
  }
})

test('用户回合进行中客户端断开，之后才需要确认：同样停住，新连接订阅后收到请求', {
  timeout: 120_000,
}, async () => {
  const scene = await startScene('unattended-user-late')
  const target = join(scene.workspace, 'late.txt')
  const held = deferred()
  try {
    scene.model.enqueue(async () => {
      await held.promise
      return writeFile(target)()
    })
    const { turn } = await scene.first.request('turn/start', {
      threadId: scene.threadId,
      input: [{ type: 'text', text: '写一个文件' }],
    })
    await until('模型请求到达', () => scene.model.requests.length === 1)
    await scene.first.disconnect()
    held.resolve()
    // 这时线程没有任何连接在看；确认请求留着，不会发到已经断开的连接上石沉大海。
    await pause(2_000)
    assert.equal(scene.model.requests.length, 1)

    const client = await scene.daemon.connect('second')
    scene.model.enqueue(say('已经写好'))
    const resumed = await client.request('thread/resume', { threadId: scene.threadId })
    assert.deepEqual(resumed.thread.status, waitingStatus)
    const request = await client.serverRequest('item/fileChange/requestApproval')
    assert.equal(request.params.turnId, turn.id)
    client.answer(request, { decision: 'accept' })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    assert.equal(await readFile(target, 'utf8'), 'WRITTEN\n')
    scene.model.assertConsumed()
  } finally {
    held.resolve()
    await dispose(scene)
  }
})

// 一个线程可以同时被几条连接订阅：后来的连接不顶掉先来的。
test('另一条连接也订阅了正在等确认的线程：两条连接都拿着这条请求，原连接不被撤回；先答的生效，另一条被告知，它之后的回答不算', {
  timeout: 120_000,
}, async () => {
  const scene = await startScene('unattended-shared')
  const target = join(scene.workspace, 'shared.txt')
  try {
    scene.model.enqueue(writeFile(target))
    const { turn } = await scene.first.request('turn/start', {
      threadId: scene.threadId,
      input: [{ type: 'text', text: '写一个文件' }],
    })
    const original = await scene.first.serverRequest('item/fileChange/requestApproval')

    // 第二条连接恢复了这个线程（另一个客户端，或者同一个客户端的另一个窗口）。
    const client = await scene.daemon.connect('second')
    await client.request('thread/resume', { threadId: scene.threadId })
    const replayed = await client.serverRequest('item/fileChange/requestApproval')
    assert.deepEqual(replayed, original, '补送的是同一条请求：请求号和参数都相同')
    const resolved = (connection: DaemonClient) =>
      connection.trace.filter(
        (message) =>
          message.method === 'serverRequest/resolved' && message.params.requestId === original.id,
      )
    await pause(500)
    assert.equal(resolved(scene.first).length, 0, '原连接没有被撤回')
    assert.equal(scene.first.serverRequests.length, 1, '原连接也不重复收到')

    // 原连接先答：拒绝。
    scene.model.enqueue((request) => {
      assert.match(lastUserText(request), /denied by user/)
      return [{ type: 'text', text: '没有写成' }]
    })
    scene.first.answer(original, { decision: 'decline' })
    for (const connection of [scene.first, client])
      assert.equal((await connection.completed(turn.id)).status, 'completed')
    assert.equal(resolved(scene.first).length, 1)
    assert.equal(resolved(client).length, 1, '另一条连接被告知这条请求已经有结果')

    // 另一条连接这时才同意：请求已经没有了，文件不会被写，模型也不会再被请求。
    client.answer(replayed, { decision: 'accept' })
    await pause(1_000)
    assert.equal(await exists(target), false, '迟到的同意不起作用')
    assert.equal(scene.model.requests.length, 2)
    scene.model.assertConsumed()
  } finally {
    await dispose(scene)
  }
})

test('子代理的调用停在确认上、超过子代理看门狗的时限：不算子代理失联，回答之后照常完成', {
  timeout: 120_000,
}, async () => {
  // 看门狗设成 2 秒，确认拖到 6 秒之后才给。
  const scene = await startScene('unattended-watchdog', { CHA_CLAUDE_SUBAGENT_TIMEOUT_MS: '2000' })
  const target = join(scene.workspace, 'child.txt')
  try {
    // 父子请求按内容归属：子代理的首条消息里带标记。
    scene.model.fallback = (request) => {
      const messages = request.messages as Array<Record<string, unknown>>
      const child = JSON.stringify(messages[0]?.content ?? '').includes('WATCHDOG_CHILD')
      const started = messages.some((message) => message.role === 'assistant')
      if (child) return started ? [{ type: 'text', text: 'CHILD_DONE' }] : writeFile(target)()
      if (started) return [{ type: 'text', text: 'PARENT_DONE' }]
      return [
        {
          type: 'tool_use',
          id: 'toolu_agent',
          name: 'Agent',
          input: {
            description: '写一个文件',
            prompt: 'WATCHDOG_CHILD 写文件',
            subagent_type: 'general-purpose',
            run_in_background: false,
          },
        },
      ]
    }
    const { turn } = await scene.first.request('turn/start', {
      threadId: scene.threadId,
      input: [{ type: 'text', text: '派子代理写一个文件' }],
    })
    const request = await scene.first.serverRequest('item/fileChange/requestApproval')
    await pause(6_000)
    assert.equal(
      scene.first.trace.some((message) => message.method === 'turn/completed'),
      false,
      '等人确认期间回合不应被看门狗结束',
    )
    scene.first.answer(request, { decision: 'accept' })
    assert.equal((await scene.first.completed(turn.id)).status, 'completed')
    assert.equal(await readFile(target, 'utf8'), 'WRITTEN\n')
    const thread = await readThread(scene.first, scene.threadId)
    assert.match(JSON.stringify(thread.turns[0].items), /PARENT_DONE/)
  } finally {
    await dispose(scene)
  }
})

test('停在确认上的线程：删除与回退被拒绝（回合还在进行），归档则打断回合、作废请求并关闭进程', {
  timeout: 120_000,
}, async () => {
  const scene = await startScene('unattended-archive')
  const target = join(scene.workspace, 'archived.txt')
  try {
    await strandOnApproval(scene, target)
    const client = await scene.daemon.connect('second')
    // 等人确认的回合仍是进行中的回合，与别的活动回合一样不能直接删除或回退。
    for (const [method, params] of [
      ['thread/delete', { threadId: scene.threadId }],
      ['thread/rollback', { threadId: scene.threadId, numTurns: 1 }],
    ] as const)
      assert.equal((await client.raw(method, params)).error?.code, -32009, method)
    assert.equal(cliProcesses(scene).length, 1)

    await client.request('thread/archive', { threadId: scene.threadId })
    await until('进程退出', () => cliProcesses(scene).length === 0)
    const thread = await readThread(client, scene.threadId)
    assert.equal(thread.turns[1].status, 'interrupted')
    await pause(1_000)
    assert.equal(client.serverRequests.length, 0)
    assert.equal(scene.model.requests.length, 3)
    assert.equal(await exists(target), false)
  } finally {
    await dispose(scene)
  }
})
