import assert from 'node:assert/strict'
import test from 'node:test'
import {
  adapterTree,
  backgroundBash,
  cliProcesses,
  commandAlive,
  disposeScene,
  listTerminals,
  runTurn,
  type Scene,
  say,
  startScene,
  uniqueSleep,
  until,
} from './fixtures/background-scene.mjs'
import { isAlive, survivors } from './fixtures/process-tree.mjs'

const commandCompletions = (scene: Scene): any[] =>
  scene.client.trace
    .filter(
      (message) =>
        message.method === 'item/completed' && message.params.item.type === 'commandExecution',
    )
    .map((message) => message.params)

// 起一条跨回合存活的后台命令，返回发起它的回合与进程。
async function keepAlive(scene: Scene, toolUseId: string, command: string) {
  scene.model.enqueue(backgroundBash(toolUseId, command))
  scene.model.enqueue(say('已在后台启动'))
  const turn = await runTurn(scene, '在后台启动一条长命令')
  const [cli] = cliProcesses(scene)
  assert.ok(cli, '回合结束后进程应留下')
  assert.equal(commandAlive(command), true)
  return { turn, cli }
}

for (const operation of ['archive', 'rollback', 'delete'] as const)
  test(`后台命令存活期间 ${operation} 线程：进程与命令都结束，条目收尾`, {
    timeout: 90_000,
  }, async () => {
    const scene = await startScene(`native-bg-${operation}`)
    const command = uniqueSleep(60)
    try {
      const { turn } = await keepAlive(scene, 'toolu_op', command)
      const tree = adapterTree(scene).map((row) => row.pid)
      if (operation === 'archive')
        await scene.client.request('thread/archive', { threadId: scene.threadId })
      else if (operation === 'rollback')
        await scene.client.request('thread/rollback', { threadId: scene.threadId, numTurns: 1 })
      else await scene.client.request('thread/delete', { threadId: scene.threadId })

      assert.deepEqual(await survivors(tree, 5_000), [], '进程表里不能有残留')
      assert.equal(commandAlive(command), false)
      const [completion] = commandCompletions(scene)
      // 删除线程时订阅已经解除，通知无处可送；条目状态以落库为准。
      if (operation !== 'delete') {
        assert.equal(completion?.turnId, turn.id)
        assert.equal(completion?.item.status, 'failed')
      }
      assert.equal(isAlive(scene.client.process.pid as number), true)
    } finally {
      await disposeScene(scene)
    }
  })

test('后台命令存活期间追加上下文：不请求模型，下一回合带上，进程不变', {
  timeout: 90_000,
}, async () => {
  const scene = await startScene('native-bg-inject')
  const command = uniqueSleep(60)
  try {
    const { cli } = await keepAlive(scene, 'toolu_inject', command)
    const requests = scene.model.requests.length
    await scene.client.request('thread/inject_items', {
      threadId: scene.threadId,
      items: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'INJECTED_CONTEXT_MARKER' }],
        },
      ],
    })
    assert.equal(scene.model.requests.length, requests, '追加上下文不应请求模型')
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(
      scene.client.trace.filter((message) => message.method === 'turn/started').length,
      1,
      '追加上下文不应产生回合',
    )
    assert.deepEqual(
      cliProcesses(scene).map((row) => row.pid),
      [cli.pid],
    )

    scene.model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages), /INJECTED_CONTEXT_MARKER/)
      return [{ type: 'text', text: '看到了追加的上下文' }]
    })
    assert.equal((await runTurn(scene, '下一回合')).status, 'completed')
    assert.deepEqual(
      cliProcesses(scene).map((row) => row.pid),
      [cli.pid],
    )
    assert.equal(commandAlive(command), true)
    scene.model.assertConsumed()
  } finally {
    await disposeScene(scene)
  }
})

test('后台命令存活期间压缩：成功，命令还在，进程不变', { timeout: 90_000 }, async () => {
  const scene = await startScene('native-bg-compact')
  const command = uniqueSleep(60)
  try {
    const { cli } = await keepAlive(scene, 'toolu_compact', command)
    scene.model.enqueue(say('这是压缩后的摘要'))
    await scene.client.request('thread/compact/start', { threadId: scene.threadId })
    await scene.client.notification('thread/compacted')
    const compactTurn = scene.client.trace
      .filter((message) => message.method === 'turn/completed')
      .at(-1)
    assert.equal(compactTurn.params.turn.status, 'completed')
    assert.deepEqual(
      cliProcesses(scene).map((row) => row.pid),
      [cli.pid],
      '压缩在同一个进程里完成',
    )
    assert.equal(commandAlive(command), true)
    assert.equal((await listTerminals(scene)).length, 1)

    scene.model.enqueue(say('压缩之后的回答'))
    assert.equal((await runTurn(scene, '压缩之后继续')).status, 'completed')
    assert.deepEqual(
      cliProcesses(scene).map((row) => row.pid),
      [cli.pid],
    )
  } finally {
    await disposeScene(scene)
  }
})

test('强杀 CLI：后台命令被清理，命令条目收尾，下一回合可以恢复', { timeout: 90_000 }, async () => {
  const scene = await startScene('native-bg-crash')
  const command = uniqueSleep(60)
  try {
    const { turn, cli } = await keepAlive(scene, 'toolu_crash', command)
    const tree = adapterTree(scene).map((row) => row.pid)
    process.kill(cli.pid, 'SIGKILL')
    assert.deepEqual(await survivors(tree, 5_000), [], '守护进程应清掉 CLI 留下的后台命令')
    assert.equal(commandAlive(command), false)
    await until('命令条目收尾', () => commandCompletions(scene).length === 1)
    const [completion] = commandCompletions(scene)
    assert.equal(completion.turnId, turn.id)
    assert.equal(completion.item.status, 'failed')
    assert.deepEqual(await listTerminals(scene), [])

    scene.model.enqueue(say('恢复之后的回答'))
    assert.equal((await runTurn(scene, '继续')).status, 'completed')
    assert.match(JSON.stringify(scene.model.requests.at(-1)?.messages), /toolu_crash/)
  } finally {
    await disposeScene(scene)
  }
})

test('保留上限为 0：回合结束进程就退出，后台命令随之停止', { timeout: 90_000 }, async () => {
  const scene = await startScene('native-bg-off', { CHA_CLAUDE_KEEP_ALIVE_SESSIONS: '0' })
  const command = uniqueSleep(60)
  try {
    scene.model.enqueue(backgroundBash('toolu_off', command))
    scene.model.enqueue(say('已在后台启动'))
    const tree = (): number[] => adapterTree(scene).map((row) => row.pid)
    const turn = await runTurn(scene, '在后台启动一条长命令')
    assert.equal(turn.status, 'completed')
    assert.deepEqual(await survivors(tree(), 8_000), [])
    assert.equal(commandAlive(command), false)
    const [completion] = commandCompletions(scene)
    assert.equal(completion?.item.status, 'failed')
  } finally {
    await disposeScene(scene)
  }
})

test('保留数达到上限：超出的线程不保留后台命令，并说明原因', { timeout: 90_000 }, async () => {
  const scene = await startScene('native-bg-limit', { CHA_CLAUDE_KEEP_ALIVE_SESSIONS: '1' })
  const first = uniqueSleep(60)
  const second = uniqueSleep(61)
  try {
    await keepAlive(scene, 'toolu_limit_a', first)
    const { thread } = await scene.client.request('thread/start', {
      cwd: scene.workspace,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    const other: Scene = { ...scene, threadId: thread.id }
    scene.model.enqueue(backgroundBash('toolu_limit_b', second))
    scene.model.enqueue(say('已在后台启动'))
    const turn = await runTurn(other, '在后台启动另一条长命令')
    assert.equal(turn.status, 'completed')
    await until('第二条命令停止', () => !commandAlive(second), 10_000)
    assert.equal(commandAlive(first), true, '先保留的不受影响')
    const warning = scene.client.trace.find(
      (message) =>
        message.method === 'warning' &&
        message.params.threadId === thread.id &&
        /上限/.test(message.params.message),
    )
    assert.ok(warning, '应说明后台命令为什么停了')
    assert.equal((await listTerminals(scene)).length, 1)
    assert.deepEqual(await listTerminals(other), [])
  } finally {
    await disposeScene(scene)
  }
})
