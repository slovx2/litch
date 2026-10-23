// 注入的后台 shell 走一遍 Pi 入口：真实的 Pi 加回环上的假模型。模型调 litch_shell_start 起一条命令、说一句收场，
// 回合结束后命令自己跑完，入口把结果作为一条不显示的消息交给 Pi，Pi 自己开一轮（记成后台任务唤醒的）。
// 守着：工具只在打开时有；集合、回合的来历只给声明了 backgroundTasks 的连接；唤醒的那一轮没有用户的话；
// 审批打开时起命令照跑命令问；用户经 backgroundTerminals 停掉的不唤醒。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { PiServer } from '../src/server.mjs'

interface Recorder extends RpcPeer {
  messages: any[]
}

function recorder(id: string): Recorder {
  const messages: any[] = []
  return {
    id,
    messages,
    close() {},
    send(message) {
      messages.push(JSON.parse(JSON.stringify(message)))
    },
  }
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function until(what: string, reached: () => boolean): Promise<void> {
  for (let waited = 0; waited < 30_000; waited += 20) {
    if (reached()) return
    await pause(20)
  }
  throw new Error(`等待超时：${what}`)
}

const frame = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'bg', object: 'chat.completion.chunk', created: 1, model: 'gate', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`

const say = (res: ServerResponse, text: string) => {
  res.write(frame({ role: 'assistant', content: text }))
  res.write(frame({}, 'stop'))
}
const call = (res: ServerResponse, name: string, args: unknown) => {
  const fn = { name, arguments: JSON.stringify(args) }
  res.write(
    frame({
      role: 'assistant',
      tool_calls: [{ index: 0, id: `call_${name}`, type: 'function', function: fn }],
    }),
  )
  res.write(frame({}, 'tool_calls'))
}

interface Scene {
  server: PiServer
  cwd: string
  /** 声明了 backgroundTasks 的连接 */
  litch: Recorder
  /** 没声明的（官方桌面端那样） */
  plain: Recorder
  /** 模型收到的每一次请求体 */
  bodies: any[]
  ok(peer: Recorder, method: string, params: unknown): Promise<any>
}

async function scene(
  options: { backgroundShell: boolean; approvals?: boolean },
  respond: (body: any, res: ServerResponse) => void,
  run: (scene: Scene) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-shell-'))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  await mkdir(agentDir)
  await mkdir(cwd)
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  const bodies: any[] = []
  const http = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    bodies.push(body)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    respond(body, res)
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const gate = {
    baseUrl: `http://127.0.0.1:${(http.address() as any).port}/v1`,
    api: 'openai-completions',
    apiKey: 'test-only',
    models: [
      {
        id: 'gate',
        name: 'Gate',
        reasoning: false,
        input: ['text'],
        contextWindow: 200000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  }
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { gate } }))
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'gate', defaultModel: 'gate', retry: { enabled: false } }),
  )
  const server = new PiServer(join(root, 'state'), options)
  let sequence = 0
  const ok = async (peer: Recorder, method: string, params: unknown): Promise<any> => {
    const id = `${peer.id}:${++sequence}`
    await server.handle(peer, { jsonrpc: '2.0', id, method, params })
    const reply = peer.messages.find((m) => m.id === id && !m.method)
    assert.equal(reply?.error, undefined, `${method}: ${JSON.stringify(reply?.error)}`)
    return reply.result
  }
  try {
    const litch = recorder('litch')
    const plain = recorder('plain')
    await ok(litch, 'initialize', {
      clientInfo: { name: 'litch', title: null, version: '1.0.0' },
      capabilities: { experimentalApi: true, litchExtensions: ['backgroundTasks'] },
    })
    await ok(plain, 'initialize', {
      clientInfo: { name: 'plain', title: null, version: '1.0.0' },
      capabilities: { experimentalApi: true },
    })
    await run({ server, cwd, litch, plain, bodies, ok })
  } finally {
    await server.close()
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}

const toolNames = (body: any): string[] =>
  (body?.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name)
const lastText = (body: any): string => {
  const last = body.messages.at(-1)
  return typeof last?.content === 'string'
    ? last.content
    : (last?.content ?? []).map((part: any) => part.text ?? '').join('')
}
const completed = (peer: Recorder) => peer.messages.filter((m) => m.method === 'turn/completed')
const changed = (peer: Recorder) =>
  peer.messages.filter((m) => m.method === 'litch/thread/background/changed')

test('BG-SHELL-PI-001：起后台命令、回合结束、命令跑完自己开一轮；集合和来历只给声明过的连接', {
  timeout: 60_000,
}, async () => {
  await scene(
    { backgroundShell: true },
    (body, res) => {
      const last = body.messages.at(-1)
      if (lastText(body).includes('<litch-background-event>')) return say(res, '后台的跑完了')
      if (last?.role === 'tool') return say(res, '已经在后台跑了')
      call(res, 'litch_shell_start', { command: 'sleep 0.5; echo bg-done', title: '演示' })
    },
    async ({ server, cwd, litch, plain, bodies, ok }) => {
      const info = await ok(litch, 'runtime/info', {})
      assert.equal(info.features.backgroundTasks, true)
      assert.ok(info.extensions.includes('backgroundTasks'))
      const threadId = (await ok(litch, 'thread/start', { cwd, model: 'gate/gate' })).thread.id
      await ok(plain, 'thread/resume', { threadId })
      await ok(litch, 'turn/start', { threadId, input: [{ type: 'text', text: '后台跑一下' }] })
      // 第一轮结束，后台命令跑完，唤醒的那一轮也结束
      await until('唤醒的一轮结束', () => completed(litch).length >= 2)
      assert.ok(toolNames(bodies[0]).includes('litch_shell_start'), '模型看得到工具')
      const [first, wake] = completed(litch).map((m) => m.params.turn)
      assert.equal(first.litchOrigin, undefined)
      assert.equal(wake.litchOrigin, 'backgroundTask')
      // 没声明的连接看到的回合不带来历、也收不到集合
      for (const m of completed(plain)) assert.equal(m.params.turn.litchOrigin, undefined)
      assert.equal(changed(plain).length, 0)
      // 集合：先 running，后 completed
      const states = changed(litch).map((m) => m.params.tasks[0]?.status)
      assert.equal(states[0], 'running')
      assert.equal(states.at(-1), 'completed')
      const task = changed(litch).at(-1).params.tasks[0]
      assert.equal(task.title, '演示')
      assert.equal(task.kind, 'shell')
      assert.equal(task.turnId, first.id)
      assert.equal(changed(litch).at(-1).params.wakesOnFinish, true)
      // 唤醒时交给模型的话里有结果和输出
      const wakeBody = bodies.find((body) => lastText(body).includes('<litch-background-event>'))
      assert.match(lastText(wakeBody), /completed \(exit code 0\)/)
      assert.match(lastText(wakeBody), /bg-done/)
      // 读会话：声明过的带集合、回合带来历；唤醒的那一轮没有用户的话
      const read = await ok(litch, 'thread/read', { threadId, includeTurns: true })
      assert.equal(read.thread.litchBackground.tasks[0].status, 'completed')
      const turns = read.thread.turns
      assert.equal(turns.at(-1).litchOrigin, 'backgroundTask')
      assert.equal(
        turns.at(-1).items.some((item: any) => item.type === 'userMessage'),
        false,
      )
      const plainRead = await ok(plain, 'thread/read', { threadId, includeTurns: true })
      assert.equal(plainRead.thread.litchBackground, undefined)
      assert.equal(plainRead.thread.turns.at(-1).litchOrigin, undefined)
      const listed = await ok(litch, 'thread/turns/list', { threadId })
      assert.ok(listed.data.some((turn: any) => turn.litchOrigin === 'backgroundTask'))
      // 来历记在库里（不在回合对象上）
      assert.equal(server.report.origin(threadId, wake.id), 'backgroundTask')
    },
  )
})

test('BG-SHELL-PI-002：用户经 backgroundTerminals 停掉的不唤醒；列得出在跑的', {
  timeout: 60_000,
}, async () => {
  await scene(
    { backgroundShell: true },
    (body, res) => {
      if (lastText(body).includes('<litch-background-event>')) return say(res, '不该来')
      if (body.messages.at(-1)?.role === 'tool') return say(res, '在跑了')
      call(res, 'litch_shell_start', { command: 'sleep 30' })
    },
    async ({ cwd, litch, bodies, ok }) => {
      const threadId = (await ok(litch, 'thread/start', { cwd, model: 'gate/gate' })).thread.id
      await ok(litch, 'turn/start', { threadId, input: [{ type: 'text', text: '跑' }] })
      await until('第一轮结束', () => completed(litch).length === 1)
      const listed = await ok(litch, 'thread/backgroundTerminals/list', { threadId })
      assert.equal(listed.data.length, 1)
      assert.equal(listed.data[0].command, 'sleep 30')
      const stopped = await ok(litch, 'thread/backgroundTerminals/terminate', {
        threadId,
        processId: listed.data[0].processId,
      })
      assert.equal(stopped.terminated, true)
      await until('停下了', () => changed(litch).at(-1)?.params.tasks[0]?.status === 'stopped')
      await pause(800)
      assert.equal(completed(litch).length, 1, '没有唤醒')
      assert.equal(bodies.length, 2)
      assert.deepEqual((await ok(litch, 'thread/backgroundTerminals/list', { threadId })).data, [])
    },
  )
})

test('BG-SHELL-PI-003：关着时模型看不到工具，声明里也不报', { timeout: 60_000 }, async () => {
  await scene(
    { backgroundShell: false },
    (_body, res) => say(res, '好'),
    async ({ cwd, litch, bodies, ok }) => {
      const info = await ok(litch, 'runtime/info', {})
      assert.equal(info.features.backgroundTasks, undefined)
      assert.equal(info.extensions.includes('backgroundTasks'), false)
      const threadId = (await ok(litch, 'thread/start', { cwd, model: 'gate/gate' })).thread.id
      await ok(litch, 'turn/start', { threadId, input: [{ type: 'text', text: '你好' }] })
      await until('回合结束', () => completed(litch).length === 1)
      assert.equal(
        toolNames(bodies[0]).some((name) => name.startsWith('litch_shell')),
        false,
      )
    },
  )
})

test('BG-SHELL-PI-004：审批打开时，起后台命令照跑命令问（带命令原文），读、列不问', {
  timeout: 60_000,
}, async () => {
  await scene(
    { backgroundShell: true, approvals: true },
    (body, res) => {
      const results = body.messages.filter((m: any) => m.role === 'tool').length
      if (results === 0) return call(res, 'litch_shell_start', { command: 'echo asked' })
      if (results === 1) return call(res, 'litch_shell_list', {})
      say(res, '好了')
    },
    async ({ server, cwd, litch, ok }) => {
      const threadId = (await ok(litch, 'thread/start', { cwd, model: 'gate/gate' })).thread.id
      await ok(litch, 'turn/start', { threadId, input: [{ type: 'text', text: '跑' }] })
      const asks = () => litch.messages.filter((m) => /requestApproval$/.test(String(m.method)))
      await until('来问了', () => asks().length > 0)
      const [request] = asks()
      assert.equal(request.method, 'item/commandExecution/requestApproval')
      assert.equal(request.params.command, 'echo asked')
      await server.handle(litch, {
        jsonrpc: '2.0',
        id: request.id,
        result: { decision: 'accept' },
      } as any)
      await until('回合结束', () => completed(litch).length >= 1)
      assert.equal(asks().length, 1, '只问了起命令的那一次')
    },
  )
})
