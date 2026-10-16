import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  cliProcesses,
  commandAlive,
  disposeScene,
  listTerminals,
  readTurns,
  runTurn,
  type Scene,
  say,
  startScene,
  uniqueSleep,
  until,
} from './fixtures/background-scene.mjs'
import type { ModelRequest } from './fixtures/mock-llm.mjs'

const toolId = (): string => `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const text = (value: string) => ({ type: 'text', text: value })
const backgroundBash = (command: string) => ({
  type: 'tool_use',
  id: toolId(),
  name: 'Bash',
  input: { command, run_in_background: true, description: 'background command' },
})
const agent = (prompt: string, foreground: boolean) => ({
  type: 'tool_use',
  id: toolId(),
  name: 'Agent',
  input: {
    description: '读取探针文件',
    prompt,
    subagent_type: 'general-purpose',
    ...(foreground ? { run_in_background: false } : {}),
  },
})

// 父子请求可能交错到达：按请求内容归属，不按到达顺序。
function shape(request: ModelRequest) {
  const messages = (request.messages ?? []) as Array<Record<string, any>>
  const lastAssistant = messages.map((message) => message.role).lastIndexOf('assistant')
  const tail = messages.slice(lastAssistant + 1)
  return {
    first: JSON.stringify(messages[0]?.content ?? ''),
    history: JSON.stringify(messages),
    started: lastAssistant >= 0,
    tailText: JSON.stringify(tail),
    tailHasToolResult: tail.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((block: any) => block.type === 'tool_result'),
    ),
  }
}

function childSteps(scene: Scene, marker: string, delayMs: number) {
  return async (request: ModelRequest) => {
    const { first, started } = shape(request)
    if (!first.includes(marker)) return null
    if (!started)
      return [
        text('CHILD_STEP 先读文件'),
        { type: 'tool_use', id: toolId(), name: 'Read', input: { file_path: probe(scene) } },
      ]
    if (delayMs) await sleep(delayMs)
    return [text('CHILD_DONE 文件内容是 42')]
  }
}

const probe = (scene: Scene): string => join(scene.workspace, 'a.txt')

const childStarted = (scene: Scene): any =>
  scene.client.trace.find(
    (message) => message.method === 'thread/started' && message.params.thread.id !== scene.threadId,
  )?.params.thread

const turnsStarted = (scene: Scene): string[] =>
  scene.client.trace
    .filter(
      (message) => message.method === 'turn/started' && message.params.threadId === scene.threadId,
    )
    .map((message) => message.params.turn.id)

const readThread = async (scene: Scene, threadId: string): Promise<any> =>
  (await scene.client.request('thread/read', { threadId, includeTurns: true })).thread

test('后台命令与后台子代理同在一个回合：回合等到子代理结果，进程和命令留下，子线程不是临时线程', {
  timeout: 120_000,
}, async () => {
  const scene = await startScene('native-bg-subagent-keep')
  const command = uniqueSleep(60)
  try {
    await writeFile(probe(scene), 'probe-file-content: 42\n')
    const child = childSteps(scene, 'KEEP_CHILD', 2_000)
    scene.model.fallback = async (request) => {
      const fromChild = await child(request)
      if (fromChild) return fromChild
      const { first, started, tailText, tailHasToolResult } = shape(request)
      assert.ok(first.includes('KEEP_MAIN'), '收到无法归属的模型请求')
      if (!started)
        return [
          text('MAIN_START'),
          backgroundBash(command),
          agent('KEEP_CHILD 读取 a.txt 并返回内容', false),
        ]
      if (tailText.includes('task-notification')) return [text('MAIN_AFTER_NOTIFICATION')]
      assert.ok(tailHasToolResult, '父会话收到未预期的请求')
      return [text('MAIN_CONTINUES')]
    }
    const first = await runTurn(scene, 'KEEP_MAIN 后台起一条命令，再派子代理读取 a.txt')
    assert.equal(first.status, 'completed')

    const started = childStarted(scene)
    assert.ok(started, '应创建子线程')
    assert.equal(started.ephemeral, false, '子线程跟随父线程，不是临时线程')
    // 子代理的最后一段正文先于父回合的结束送达：回合确实等到了它。
    const methods = scene.client.trace.map((message) => message)
    const childDone = methods.findIndex(
      (message) =>
        message.method === 'item/completed' &&
        message.params.threadId === started.id &&
        message.params.item.type === 'agentMessage' &&
        /CHILD_DONE/.test(message.params.item.text),
    )
    const parentDone = methods.findIndex(
      (message) => message.method === 'turn/completed' && message.params.turn.id === first.id,
    )
    assert.ok(childDone >= 0 && childDone < parentDone, '父回合要等到子代理的结果')
    assert.equal((await readThread(scene, started.id)).status.type, 'idle')
    const wait = (await readTurns(scene))[0].items.find(
      (item: any) => item.type === 'collabAgentToolCall' && item.tool === 'wait',
    )
    assert.equal(wait.agentsStates[started.id].status, 'completed')

    // 子代理结束后回合收尾，后台命令还在：进程留下，命令条目仍在进行。
    assert.equal(commandAlive(command), true)
    const [cli] = cliProcesses(scene)
    assert.ok(cli, '回合结束后进程应留下')
    assert.equal((await listTerminals(scene)).length, 1)
    const stored = (await readTurns(scene))[0].items.find(
      (item: any) => item.type === 'commandExecution',
    )
    assert.equal(stored.status, 'inProgress')

    scene.model.enqueue(say('第二回合的回答'))
    assert.equal((await runTurn(scene, '随便回答一句')).status, 'completed')
    assert.deepEqual(
      cliProcesses(scene).map((row) => row.pid),
      [cli.pid],
      '第二回合复用同一个进程',
    )
    assert.equal(commandAlive(command), true)
  } finally {
    await disposeScene(scene)
  }
})

test('自行续跑的回合里派出子代理：子线程照常出现并收尾，不是临时线程', {
  timeout: 120_000,
}, async () => {
  const scene = await startScene('native-bg-subagent-spawn')
  const command = `${uniqueSleep(1)} && echo SPAWN_BG_DONE`
  try {
    await writeFile(probe(scene), 'probe-file-content: 42\n')
    const child = childSteps(scene, 'SPAWN_CHILD', 0)
    scene.model.fallback = async (request) => {
      const fromChild = await child(request)
      if (fromChild) return fromChild
      const { first, history, started, tailText, tailHasToolResult } = shape(request)
      assert.ok(first.includes('SPAWN_MAIN'), '收到无法归属的模型请求')
      const launched = history.includes('"name":"Agent"')
      if (!started) return [text('MAIN_START'), backgroundBash(command)]
      // 后台命令结束后的那一轮：模型决定派一个子代理去处理。
      if (!launched && tailText.includes('task-notification'))
        return [text('NOTE_SPAWN'), agent('SPAWN_CHILD 读取 a.txt 并返回内容', true)]
      assert.ok(tailHasToolResult, '父会话收到未预期的请求')
      return [text(launched ? 'MAIN_AFTER_AGENT 子代理读到了 42' : 'MAIN_STARTED')]
    }
    assert.equal((await runTurn(scene, 'SPAWN_MAIN 后台起一条很快结束的命令')).status, 'completed')
    await until('自行续跑的回合开始', () => turnsStarted(scene).length === 2)
    const spontaneousId = turnsStarted(scene)[1] as string
    assert.equal((await scene.client.completed(spontaneousId)).status, 'completed')

    const started = childStarted(scene)
    assert.ok(started, '自行续跑的回合里也应创建子线程')
    assert.equal(started.ephemeral, false)
    const childThread = await readThread(scene, started.id)
    assert.equal(childThread.status.type, 'idle')
    assert.match(JSON.stringify(childThread.turns.at(-1).items), /CHILD_DONE 文件内容是 42/)
    assert.ok(
      scene.client.trace.some(
        (message) =>
          message.method === 'item/completed' &&
          message.params.threadId === started.id &&
          message.params.item.type === 'agentMessage',
      ),
      '子线程的正文要以通知送达',
    )
    // 与普通回合一致：默认列表不含子线程，按父线程能查到。
    const listed = async (params: Record<string, unknown>): Promise<string[]> =>
      (await scene.client.request('thread/list', params)).data.map((thread: any) => thread.id)
    assert.equal((await listed({})).includes(started.id), false)
    assert.deepEqual(await listed({ parentThreadId: scene.threadId }), [started.id])

    const turns = await readTurns(scene)
    assert.equal(turns.length, 2)
    const items = turns[1].items
    assert.equal(
      items.some((item: any) => item.type === 'userMessage'),
      false,
    )
    const spawn = items.find(
      (item: any) => item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent',
    )
    assert.deepEqual(spawn.receiverThreadIds, [started.id])
    assert.match(JSON.stringify(items.at(-1)), /MAIN_AFTER_AGENT/)
    assert.ok(!JSON.stringify(items).includes('CHILD_DONE'), '子代理的正文不混入父线程')
  } finally {
    await disposeScene(scene)
  }
})

test('复用进程的回合带输出格式：约束仍由 CLI 强制；输出格式变了则重启进程并说明', {
  timeout: 120_000,
}, async () => {
  const scene = await startScene('native-bg-output-schema')
  const command = uniqueSleep(60)
  // 2020-12 的元组写法，交给 CLI 前要换成 draft-07 的等价写法。
  const outputSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }], items: false },
    },
    required: ['pair'],
    additionalProperties: false,
  }
  const structured = (id: string, pair: unknown[]) => () => [
    { type: 'tool_use', id, name: 'StructuredOutput', input: { pair } },
  ]
  const structuredTurn = async (prompt: string): Promise<any> => {
    const { turn } = await scene.client.request('turn/start', {
      threadId: scene.threadId,
      input: [{ type: 'text', text: prompt }],
      outputSchema,
    })
    return scene.client.completed(turn.id)
  }
  const answer = async (): Promise<unknown> =>
    JSON.parse(
      (await readTurns(scene)).at(-1).items.find((item: any) => item.type === 'agentMessage').text,
    )
  try {
    scene.model.enqueue(() => [backgroundBash(command)])
    scene.model.enqueue(structured('toolu_first', ['a', 1]))
    const first = await structuredTurn('后台起一条长命令，然后按格式回答')
    assert.equal(first.status, 'completed', JSON.stringify(first.error))
    assert.deepEqual(await answer(), { pair: ['a', 1] })
    const [cli] = cliProcesses(scene)
    assert.ok(cli, '回合结束后进程应留下')

    // 同一个进程上的第二个回合：多给一个元素违反 items: false，CLI 仍会拒收。
    scene.model.enqueue((request) => {
      const tool = (request.tools as any[]).find((entry) => entry.name === 'StructuredOutput')
      assert.ok(!JSON.stringify(tool.input_schema).includes('prefixItems'), '模式已换成等价写法')
      return structured('toolu_bad', ['b', 2, 'extra'])()
    })
    scene.model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages.at(-1)), /does not match required schema/)
      return structured('toolu_good', ['b', 2])()
    })
    const second = await structuredTurn('再按格式回答一次')
    assert.equal(second.status, 'completed', JSON.stringify(second.error))
    assert.deepEqual(await answer(), { pair: ['b', 2] })
    assert.deepEqual(
      cliProcesses(scene).map((row) => row.pid),
      [cli.pid],
      '输出格式没变，复用同一个进程',
    )
    assert.equal(commandAlive(command), true)

    // 不带输出格式的回合：输出格式是启动配置，进程要重启，后台命令随之停止并说明。
    scene.model.enqueue(say('普通回答'))
    assert.equal((await runTurn(scene, '不带格式的回合')).status, 'completed')
    assert.ok(
      scene.client.trace.some(
        (message) => message.method === 'warning' && /重新启动/.test(message.params.message),
      ),
      '应说明后台命令为什么停了',
    )
    assert.equal(commandAlive(command), false)
    assert.notEqual(cliProcesses(scene)[0]?.pid, cli.pid)
    scene.model.assertConsumed()
  } finally {
    await disposeScene(scene)
  }
})
