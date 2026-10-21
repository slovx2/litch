// 回合结束后 CLI 进程空闲保留（CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS）：真的 Claude Code CLI、回环上的假模型。
// 默认 0：没有后台命令时回合结束进程就退出（现状）。大于 0 时留到超时，下个回合直接用；
// 和后台命令共用 CHA_CLAUDE_KEEP_ALIVE_SESSIONS 的上限，满了先回收闲得最久的；
// 线程关闭、客户端全断开时马上回收；留着的进程照旧占着它的 MCP 连接，回收后连接按连接池的规矩处理。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  backgroundBash,
  cliProcesses,
  commandAlive,
  disposeScene,
  runTurn,
  type Scene,
  say,
  startScene,
  uniqueSleep,
  until,
} from './fixtures/background-scene.mjs'
import { claudeCliCommand } from './fixtures/claude-cli.mjs'
import { Daemon } from './fixtures/daemon.mjs'
import { countedServers, countServer } from './fixtures/mcp-count.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { descendants, killAll } from './fixtures/process-tree.mjs'

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const pids = (scene: Scene) => cliProcesses(scene).map((row) => row.pid)

async function reply(scene: Scene, text: string): Promise<void> {
  scene.model.enqueue(say(text))
  assert.equal((await runTurn(scene, '说一句')).status, 'completed')
}

async function otherThread(scene: Scene): Promise<Scene> {
  const { thread } = await scene.client.request('thread/start', {
    cwd: scene.workspace,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  })
  return { ...scene, threadId: thread.id }
}

test('KEEP-IDLE-001：默认不留，回合结束 CLI 就退出', { timeout: 60_000 }, async () => {
  const scene = await startScene('keep-idle-default')
  try {
    await reply(scene, '好的')
    await until('CLI 退出', () => pids(scene).length === 0, 10_000)
  } finally {
    await disposeScene(scene)
  }
})

test('KEEP-IDLE-002：开了空闲保留，下个回合用同一个 CLI；归档线程马上回收', {
  timeout: 60_000,
}, async () => {
  const scene = await startScene('keep-idle-reuse', { CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS: '60' })
  try {
    await reply(scene, '第一句')
    const [first] = pids(scene)
    assert.ok(first, '回合结束后 CLI 应留下')
    await pause(500)
    await reply(scene, '第二句')
    assert.deepEqual(pids(scene), [first], '第二回合直接用留着的 CLI')
    // 第二回合的请求里带着第一回合的话：确实是同一个会话接着说
    assert.match(JSON.stringify(scene.model.requests.at(-1)?.messages), /第一句/)
    await scene.client.request('thread/archive', { threadId: scene.threadId })
    await until('归档后 CLI 退出', () => pids(scene).length === 0, 5_000)
  } finally {
    await disposeScene(scene)
  }
})

test('KEEP-IDLE-003：空闲到时退出', { timeout: 60_000 }, async () => {
  const scene = await startScene('keep-idle-expire', { CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS: '3' })
  try {
    await reply(scene, '好的')
    const finished = Date.now()
    await pause(1_500)
    assert.equal(pids(scene).length, 1, '还没到时')
    await until('到时退出', () => pids(scene).length === 0, 10_000)
    assert.ok(Date.now() - finished >= 3_000, '不早于设定的时长')
  } finally {
    await disposeScene(scene)
  }
})

test('KEEP-IDLE-004：保留数满了先回收闲得最久的，不提示；后台命令的会话不让位给空闲的', {
  timeout: 90_000,
}, async () => {
  const scene = await startScene('keep-idle-limit', {
    CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS: '60',
    CHA_CLAUDE_KEEP_ALIVE_SESSIONS: '2',
  })
  const command = uniqueSleep(60)
  try {
    // 甲留着一条后台命令，乙只是空闲
    scene.model.enqueue(backgroundBash('toolu_keep_idle', command))
    scene.model.enqueue(say('已在后台启动'))
    assert.equal((await runTurn(scene, '在后台启动一条长命令')).status, 'completed')
    const second = await otherThread(scene)
    await reply(second, '乙')
    assert.equal(pids(scene).length, 2)
    // 丙要留：满了，回收空闲的乙，有后台命令的甲不动
    const third = await otherThread(scene)
    await reply(third, '丙')
    await until('乙被回收', () => pids(scene).length === 2 && commandAlive(command), 10_000)
    await pause(500)
    assert.equal(pids(scene).length, 2)
    assert.equal(commandAlive(command), true)
    assert.equal(
      scene.client.trace.some((message) => message.method === 'warning'),
      false,
      '空闲的进程被回收不丢东西，不用提示',
    )
    // 乙再来一个回合：起新的 CLI，回收此时闲得最久的丙
    const before = new Set(pids(scene))
    await reply(second, '乙又来了')
    await until(
      '丙被回收、乙是新起的',
      () => {
        const after = pids(scene)
        return after.length === 2 && after.filter((pid) => !before.has(pid)).length === 1
      },
      10_000,
    )
    assert.equal(commandAlive(command), true)
  } finally {
    await disposeScene(scene)
  }
})

test('KEEP-IDLE-005：后台命令结束后照空闲保留的时长留着，不是 2 秒就退', {
  timeout: 60_000,
}, async () => {
  const scene = await startScene('keep-idle-shell', { CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS: '8' })
  const command = uniqueSleep(2)
  try {
    scene.model.enqueue(backgroundBash('toolu_short', command))
    scene.model.enqueue(say('已在后台启动'))
    assert.equal((await runTurn(scene, '在后台跑一条短命令')).status, 'completed')
    // 命令结束后 CLI 会自己再跑一轮报结果
    scene.model.enqueue(say('命令跑完了'))
    await until('后台命令结束', () => !commandAlive(command), 15_000)
    await pause(4_000)
    assert.equal(pids(scene).length, 1, '没有后台命令了，照空闲保留留着')
    await until('到时退出', () => pids(scene).length === 0, 15_000)
  } finally {
    await disposeScene(scene)
  }
})

test('KEEP-IDLE-006：守护进程上的客户端全断开，空闲保留的 CLI 和它的 MCP 服务马上回收', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'keep-idle-detach-'))
  const cwd = join(home, 'project')
  const log = join(home, 'counted.jsonl')
  await mkdir(cwd)
  const model = new MockLLM()
  const daemon = await Daemon.start(home, await model.start(), {
    CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS: '600',
  })
  const cli = claudeCliCommand()
  const clis = () =>
    descendants(daemon.process.pid as number).filter((row) => row.command.startsWith(cli))
  try {
    const client = await daemon.connect('first', {
      optOutNotificationMethods: ['mcpServer/startupStatus/updated'],
    })
    const { thread } = await client.request('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      config: { mcp_servers: { counted: countServer(log) } },
    })
    for (const id of ['toolu_1', 'toolu_2']) {
      model.enqueue(() => [{ type: 'tool_use', id, name: 'mcp__counted__echo', input: {} }])
      model.enqueue(() => [{ type: 'text', text: 'DONE' }])
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '调一次 echo' }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
    }
    model.assertConsumed()
    assert.equal(clis().length, 1, '两个回合用的是同一个留着的 CLI')
    const servers = await countedServers(log)
    assert.deepEqual(
      servers.map((server) => [server.called, server.closed]),
      [[['echo', 'echo'], false]],
    )
    await client.disconnect()
    await until('CLI 被回收', () => clis().length === 0, 10_000)
    await until(
      'MCP 服务被关掉',
      async () => (await countedServers(log))[0]?.closed === true,
      10_000,
    )
  } finally {
    const tree = descendants(daemon.process.pid as number).map((row) => row.pid)
    await daemon.close()
    await model.close()
    killAll(tree)
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
