import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { claudeCliCommand } from './fixtures/claude-cli.mjs'
import { deferred } from './fixtures/deferred.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import {
  descendants,
  isAlive,
  killAll,
  processTable,
  survivors,
  waitForCommand,
} from './fixtures/process-tree.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 每个用例用不同的时长，按命令行就能在进程表里认出自己起的那条命令。
const uniqueSleep = (): string => `sleep 47.${String(process.hrtime.bigint()).slice(-6)}`

interface Scene {
  home: string
  model: MockLLM
  client: ProtocolClient
  held: ReturnType<typeof deferred>
  threadId: string
  turnId: string
  command: string
  // 适配器的全部后代：守护进程、CLI、后台命令的包装进程和命令本身。
  tree: number[]
}

// 起一个回合：模型先在后台起一条长命令，第二次模型请求挂起，回合保持进行中。
async function backgroundTurn(): Promise<Scene> {
  const home = await mkdtemp(join(tmpdir(), 'native-cleanup-'))
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  const held = deferred()
  const command = uniqueSleep()
  const { thread } = await client.request('thread/start', {
    cwd: workspace,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  })
  model.enqueue(() => [
    {
      type: 'tool_use',
      id: 'toolu_cleanup_bg',
      name: 'Bash',
      input: { command, run_in_background: true, description: 'background sleep' },
    },
  ])
  model.enqueue(async () => {
    await held.promise
    return [{ type: 'text', text: '后台任务已启动' }]
  })
  const { turn } = await client.request('turn/start', {
    threadId: thread.id,
    input: [{ type: 'text', text: '启动后台任务' }],
  })
  await waitForCommand(command, 20_000)
  // 第二次模型请求到达后才算“回合进行中且后台命令在跑”。
  for (let attempt = 0; attempt < 200 && model.requests.length < 2; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(model.requests.length, 2, client.stderr.slice(-2000))
  const tree = descendants(client.process.pid as number).map((row) => row.pid)
  return { home, model, client, held, threadId: thread.id, turnId: turn.id, command, tree }
}

async function dispose(scene: Scene): Promise<void> {
  scene.held.resolve()
  await scene.client.close()
  await scene.model.close()
  killAll(scene.tree)
  await rm(scene.home, { recursive: true, force: true })
}

const describeLeft = (pids: number[]): string =>
  JSON.stringify(processTable().filter((row) => pids.includes(row.pid)))

test('适配器被强杀后，CLI 与后台命令都不留下，也不再请求模型', { timeout: 90_000 }, async () => {
  const scene = await backgroundTurn()
  try {
    assert.ok(scene.tree.length >= 3, `进程树过小：${describeLeft(scene.tree)}`)
    const requests = scene.model.requests.length
    scene.client.crash()
    const left = await survivors(scene.tree, 2_000)
    assert.deepEqual(left, [], `残留进程：${describeLeft(left)}`)
    // 守护进程先让 CLI 自己收尾；这期间 CLI 不能把断线当成工具错误再去请求模型。
    await new Promise((resolve) => setTimeout(resolve, 700))
    assert.equal(scene.model.requests.length, requests)
  } finally {
    await dispose(scene)
  }
})

test('适配器正常退出后，CLI 与后台命令都不留下', { timeout: 90_000 }, async () => {
  const scene = await backgroundTurn()
  try {
    await scene.client.close()
    const left = await survivors(scene.tree, 2_000)
    assert.deepEqual(left, [], `残留进程：${describeLeft(left)}`)
  } finally {
    await dispose(scene)
  }
})

test('CLI 被强杀后，守护进程清掉它留下的后台命令', { timeout: 90_000 }, async () => {
  const scene = await backgroundTurn()
  try {
    const table = processTable()
    // 守护进程的命令行里也带着 CLI 的路径，按开头区分。
    const cli = table.find(
      (row) => scene.tree.includes(row.pid) && row.command.startsWith(claudeCliCommand()),
    )
    assert.ok(cli, `没有找到 CLI 进程：${describeLeft(scene.tree)}`)
    process.kill(cli.pid, 'SIGKILL')
    const left = await survivors(scene.tree, 3_000)
    assert.deepEqual(left, [], `残留进程：${describeLeft(left)}`)
    const completed = await scene.client.completed(scene.turnId)
    assert.equal(completed.status, 'failed')
    assert.equal(isAlive(scene.client.process.pid as number), true)
  } finally {
    await dispose(scene)
  }
})
