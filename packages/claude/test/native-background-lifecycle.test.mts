import assert from 'node:assert/strict'
import test from 'node:test'
import {
  adapterTree,
  backgroundBash,
  cliProcesses,
  commandAlive,
  disposeScene,
  lastUserText,
  listTerminals,
  readTurns,
  runTurn,
  type Scene,
  say,
  startScene,
  uniqueSleep,
  until,
} from './fixtures/background-scene.mjs'
import { deferred } from './fixtures/deferred.mjs'
import { isAlive, survivors } from './fixtures/process-tree.mjs'

const commandItem = (scene: Scene, toolUseId: string): any =>
  scene.client.trace.find(
    (message) =>
      message.method === 'item/started' &&
      message.params.item.type === 'commandExecution' &&
      message.params.item.processId === `claude:${toolUseId}`,
  )?.params

const completions = (scene: Scene, itemId: string): any[] =>
  scene.client.trace
    .filter((message) => message.method === 'item/completed' && message.params.item.id === itemId)
    .map((message) => message.params)

/** 给模型的话里有几处“被用户停了” */
const stoppedNotes = (text: string): number => text.split('was stopped by the user').length - 1

const turnsStarted = (scene: Scene): string[] =>
  scene.client.trace
    .filter((message) => message.method === 'turn/started')
    .map((message) => message.params.turn.id)

test('后台命令跨回合存活：回合结束后命令条目仍在进行，下一回合用同一个进程', {
  timeout: 90_000,
}, async () => {
  const scene = await startScene('native-bg-keep')
  const command = uniqueSleep(60)
  try {
    scene.model.enqueue(backgroundBash('toolu_keep', command))
    scene.model.enqueue(say('已在后台启动'))
    const first = await runTurn(scene, '在后台启动一条长命令')
    assert.equal(first.status, 'completed')

    const started = commandItem(scene, 'toolu_keep')
    assert.ok(started, '应有命令条目')
    assert.deepEqual(completions(scene, started.item.id), [], '命令还在跑，条目不能被标成结束')
    assert.equal(commandAlive(command), true)
    const [cli] = cliProcesses(scene)
    assert.ok(cli, `回合结束后进程应留下：${JSON.stringify(adapterTree(scene))}`)

    const listed = await listTerminals(scene)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.processId, 'claude:toolu_keep')
    assert.equal(listed[0]?.itemId, started.item.id)

    const stored = (await readTurns(scene))[0].items.find(
      (item: any) => item.id === started.item.id,
    )
    assert.equal(stored.status, 'inProgress')

    scene.model.enqueue(say('第二回合的回答'))
    const second = await runTurn(scene, '随便回答一句')
    assert.equal(second.status, 'completed')
    assert.deepEqual(
      cliProcesses(scene).map((row) => row.pid),
      [cli.pid],
      '第二回合应复用同一个进程',
    )
    assert.equal(commandAlive(command), true)
    assert.equal((await listTerminals(scene)).length, 1)
    assert.deepEqual(completions(scene, started.item.id), [])
    // 第二回合的请求带着第一回合的历史：同一个会话接着用，没有另起一份。
    assert.match(JSON.stringify(scene.model.requests.at(-1)?.messages), /toolu_keep/)
    scene.model.assertConsumed()

    const tree = adapterTree(scene).map((row) => row.pid)
    await scene.client.close()
    assert.deepEqual(await survivors(tree, 3_000), [], '适配器退出后不能留下进程')
    assert.equal(commandAlive(command), false)
  } finally {
    await disposeScene(scene)
  }
})

test('后台命令自己结束：命令条目补完成通知，CLI 自行续跑成为一个没有用户消息的回合', {
  timeout: 90_000,
}, async () => {
  const scene = await startScene('native-bg-finish', { CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS: '0' })
  const command = `${uniqueSleep(2)} && echo BG_DONE_MARKER`
  try {
    scene.model.enqueue(backgroundBash('toolu_finish', command))
    scene.model.enqueue(say('已在后台启动'))
    // 命令结束后 CLI 把结果告诉模型，这一次请求不是任何 turn/start 引起的。
    scene.model.enqueue((request) => {
      assert.match(lastUserText(request), /task-notification/)
      return [{ type: 'text', text: '后台命令已经结束' }]
    })
    const first = await runTurn(scene, '在后台启动一条短命令')
    assert.equal(first.status, 'completed')
    const started = commandItem(scene, 'toolu_finish')
    const tree = adapterTree(scene).map((row) => row.pid)

    await until('自行续跑的回合开始', () => turnsStarted(scene).length === 2)
    const spontaneousId = turnsStarted(scene)[1] as string
    const spontaneous = await scene.client.completed(spontaneousId)
    assert.equal(spontaneous.status, 'completed')

    const [completion] = completions(scene, started.item.id)
    assert.ok(completion, '命令结束后应补发条目完成通知')
    assert.equal(completion.turnId, first.id, '通知带的是发起命令的那个回合')
    assert.equal(completion.item.status, 'completed')
    assert.equal(completion.item.exitCode, 0)
    assert.match(completion.item.aggregatedOutput, /BG_DONE_MARKER/)

    // 状态通知包住这个回合：active → turn/started → … → idle → turn/completed。
    const methods = scene.client.trace
      .filter((message) => typeof message.method === 'string' && message.id == null)
      .map((message) => ({ method: message.method as string, params: message.params }))
    const startIndex = methods.findIndex(
      (entry) => entry.method === 'turn/started' && entry.params.turn.id === spontaneousId,
    )
    const before = methods
      .slice(0, startIndex)
      .reverse()
      .find((entry) => entry.method === 'thread/status/changed')
    assert.equal(before?.params.status.type, 'active')
    const after = methods
      .slice(startIndex)
      .find(
        (entry) => entry.method === 'thread/status/changed' && entry.params.status.type === 'idle',
      )
    assert.ok(after, '回合结束后线程应回到空闲')

    const turns = await readTurns(scene)
    assert.equal(turns.length, 2)
    assert.equal(turns[1].id, spontaneousId)
    assert.equal(
      turns[1].items.some((item: any) => item.type === 'userMessage'),
      false,
    )
    assert.match(JSON.stringify(turns[1].items), /后台命令已经结束/)
    assert.equal(
      turns[0].items.find((item: any) => item.id === started.item.id).status,
      'completed',
    )

    // 没有后台命令了，进程不再保留。
    assert.deepEqual(await survivors(tree, 8_000), [], '回合结束后进程应退出')
    assert.equal(isAlive(scene.client.process.pid as number), true)
    scene.model.assertConsumed()
  } finally {
    await disposeScene(scene)
  }
})

for (const method of ['terminate', 'clean'] as const)
  test(`空闲时 ${method} 后台命令：命令停止，条目收尾，不产生新回合`, {
    timeout: 90_000,
  }, async () => {
    const scene = await startScene(`native-bg-${method}`, {
      CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS: '0',
    })
    const command = uniqueSleep(60)
    try {
      scene.model.enqueue(backgroundBash('toolu_stop', command))
      scene.model.enqueue(say('已在后台启动'))
      const first = await runTurn(scene, '在后台启动一条长命令')
      const started = commandItem(scene, 'toolu_stop')
      const tree = adapterTree(scene).map((row) => row.pid)
      assert.equal(commandAlive(command), true)

      if (method === 'terminate')
        assert.deepEqual(
          await scene.client.request('thread/backgroundTerminals/terminate', {
            threadId: scene.threadId,
            processId: 'claude:toolu_stop',
          }),
          { terminated: true },
        )
      else
        await scene.client.request('thread/backgroundTerminals/clean', {
          threadId: scene.threadId,
        })

      await until('命令条目收尾', () => completions(scene, started.item.id).length === 1)
      const [completion] = completions(scene, started.item.id)
      assert.equal(completion.turnId, first.id)
      assert.equal(completion.item.status, 'failed')
      // 条目收尾的通知来自 CLI 报的“已停止”，进程真的退出可能晚几毫秒（clean 不等终止完成就返回）：
      // 等它退出，不在通知到的那一刻去断言
      await until('命令进程退出', () => !commandAlive(command), 5_000)
      assert.deepEqual(await listTerminals(scene), [])
      // 被停掉的命令不会让 CLI 续跑；留着的进程随后退出。
      assert.deepEqual(await survivors(tree, 8_000), [])
      assert.equal(turnsStarted(scene).length, 1, '不应出现新回合')
      assert.equal(scene.model.requests.length, 2)
      scene.model.assertConsumed()

      // 进程退出后线程照常可用：下一回合另起进程接着原来的历史。
      scene.model.enqueue(say('还能继续'))
      assert.equal((await runTurn(scene, '继续')).status, 'completed')
      const next = JSON.stringify(scene.model.requests.at(-1)?.messages)
      assert.match(next, /toolu_stop/)
      // CLI 那条“被用户停了”的通知随进程没了，由 Litch 在这一轮补上，只一次
      assert.equal(stoppedNotes(next), 1, next)
      assert.ok(next.includes('<tool-use-id>toolu_stop</tool-use-id>'), next)
      assert.ok(next.includes('<status>killed</status>'), next)
      scene.model.enqueue(say('再来'))
      assert.equal((await runTurn(scene, '再来')).status, 'completed')
      assert.equal(stoppedNotes(JSON.stringify(scene.model.requests.at(-1)?.messages)), 1)
      // 画出来的用户的话里没有这段
      assert.doesNotMatch(JSON.stringify(await readTurns(scene)), /stopped by the user/)
    } finally {
      await disposeScene(scene)
    }
  })

test('空闲时停掉后台命令、进程还留着：下一轮由 CLI 自己告诉模型，Litch 不重复', {
  timeout: 90_000,
}, async () => {
  const scene = await startScene('native-bg-stop-kept', {
    CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS: '120',
  })
  const command = uniqueSleep(60)
  try {
    scene.model.enqueue(backgroundBash('toolu_kept', command))
    scene.model.enqueue(say('已在后台启动'))
    await runTurn(scene, '在后台启动一条长命令')
    const [cli] = cliProcesses(scene)
    assert.ok(cli)
    assert.deepEqual(
      await scene.client.request('thread/backgroundTerminals/terminate', {
        threadId: scene.threadId,
        processId: 'claude:toolu_kept',
      }),
      { terminated: true },
    )
    await until('命令进程退出', () => !commandAlive(command), 5_000)
    await new Promise((resolve) => setTimeout(resolve, 800))
    assert.equal(turnsStarted(scene).length, 1, '不应出现新回合')
    scene.model.enqueue(say('知道了'))
    assert.equal((await runTurn(scene, '继续')).status, 'completed')
    assert.deepEqual(
      cliProcesses(scene).map((row) => row.pid),
      [cli.pid],
      '还是同一个进程',
    )
    const next = JSON.stringify(scene.model.requests.at(-1)?.messages)
    assert.equal(stoppedNotes(next), 1, next)
  } finally {
    await disposeScene(scene)
  }
})

test('打断回合不连带停掉后台命令：进程留下，下一回合接着用', { timeout: 90_000 }, async () => {
  const scene = await startScene('native-bg-interrupt')
  const command = uniqueSleep(60)
  const held = deferred()
  try {
    scene.model.enqueue(backgroundBash('toolu_survive', command))
    scene.model.enqueue(async () => {
      await held.promise
      return [{ type: 'text', text: '不会送达' }]
    })
    const { turn } = await scene.client.request('turn/start', {
      threadId: scene.threadId,
      input: [{ type: 'text', text: '在后台启动一条长命令' }],
    })
    await until('第二次模型请求到达', () => scene.model.requests.length === 2)
    await until('后台命令在列表里', async () => (await listTerminals(scene)).length === 1)
    const [cli] = cliProcesses(scene)
    assert.ok(cli)

    await scene.client.request('turn/interrupt', { threadId: scene.threadId, turnId: turn.id })
    assert.equal((await scene.client.completed(turn.id)).status, 'interrupted')
    held.resolve()

    assert.equal(commandAlive(command), true, '打断只中止这一轮')
    assert.deepEqual(
      cliProcesses(scene).map((row) => row.pid),
      [cli.pid],
    )
    assert.equal((await listTerminals(scene)).length, 1)
    const started = commandItem(scene, 'toolu_survive')
    assert.deepEqual(completions(scene, started.item.id), [], '命令还在跑，条目不随回合收尾')

    scene.model.enqueue(say('打断之后的回答'))
    const next = await runTurn(scene, '继续')
    assert.equal(next.status, 'completed')
    assert.deepEqual(
      cliProcesses(scene).map((row) => row.pid),
      [cli.pid],
    )
    assert.equal(commandAlive(command), true)
  } finally {
    held.resolve()
    await disposeScene(scene)
  }
})
