// 端到端：真的 Pi 运行时加回环上的假模型，设备进程（进程内，时钟可拨）收在聚合面后面。
// 1. 没有任何客户端连着时到点跑出会话，运行记录 succeeded；之后客户端连上，thread/list 里看得到它。
//    任务自己的回合里模型调 litch_tasks（list），由设备进程经它的内部连接答复。
// 2. 客户端发起的回合里模型调 litch_tasks（create），Pi 挑中的执行方是设备进程替这条连接开的上游连接，
//    设备答复，客户端收不到这个请求；建出来的任务在发起调用的会话里接着发。
import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { TASKS_TOOLS } from '../../protocol/src/client-tools-tasks.mjs'
import { DeviceServer } from '../src/device.mjs'
import { unixConnector } from '../src/sockets.mjs'
import { REPO, TestClient, tempDir } from './helpers.mjs'
import { DECLARED, FakeClock, until } from './task-kit.mjs'

const MINUTE = 60_000

/** Pi 给动态工具起的名字（packages/pi 的做法：命名空间和工具名的摘要） */
const piToolName = (namespace: string, name: string) =>
  `client_${createHash('sha256')
    .update(JSON.stringify([namespace, name]))
    .digest('hex')
    .slice(0, 32)}`

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part: any) => (part?.type === 'text' ? part.text : '')).join('')
      : ''

/** 假模型怎么回：工具结果回来就把它说出来；定时任务的提示词调 list；“建个任务”调 create；别的回“好的。” */
function reply(body: any): { text?: string; tool?: { name: string; args: unknown } } {
  const messages: any[] = body.messages ?? []
  const last = messages.at(-1)
  if (last?.role === 'tool') return { text: `工具答复：${textOf(last.content).slice(0, 300)}` }
  const user = textOf(messages.findLast((message) => message.role === 'user')?.content)
  if (user.includes('[Scheduled task run]'))
    return { tool: { name: piToolName('litch_tasks', 'list'), args: {} } }
  if (user.includes('建个任务'))
    return {
      tool: {
        name: piToolName('litch_tasks', 'create'),
        args: {
          name: '喝水',
          prompt: '提醒我喝水。',
          schedule: { type: 'interval', minutes: 30 },
          timezone: 'Asia/Shanghai',
        },
      },
    }
  return { text: '好的。' }
}

function serveModel(): Promise<Server> {
  let serial = 0
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    const answer = reply(body)
    const base = {
      id: `mock_${++serial}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: body.model,
    }
    const chunk = (delta: unknown, finish: string | null = null, extra = {}) =>
      response.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`,
      )
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (answer.tool)
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call_${serial}`,
            type: 'function',
            function: { name: answer.tool.name, arguments: JSON.stringify(answer.tool.args) },
          },
        ],
      })
    else chunk({ role: 'assistant', content: answer.text })
    chunk({}, answer.tool ? 'tool_calls' : 'stop', {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
    response.end('data: [DONE]\n\n')
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/** 起一份隔离的 Pi 运行时：自己的状态目录、配置目录，模型打到回环上的假模型 */
async function startPi(
  root: string,
  modelPort: number,
): Promise<{ child: ChildProcess; socket: string }> {
  const engine = join(REPO, 'packages/pi/dist/pi/src/adapter.mjs')
  assert.ok(existsSync(engine), '缺少 packages/pi 的构建产物')
  const piPackage = join(REPO, 'packages/pi/node_modules/@earendil-works/pi-coding-agent')
  const piEntry = JSON.parse(readFileSync(join(piPackage, 'package.json'), 'utf8')).main
  const agent = join(root, 'agent')
  const state = join(root, 'state')
  for (const directory of [agent, state, join(root, 'home')])
    mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(agent, 'models.json'),
    JSON.stringify({
      providers: {
        gate: {
          baseUrl: `http://127.0.0.1:${modelPort}/v1`,
          api: 'openai-completions',
          apiKey: 'fixture-only',
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
        },
      },
    }),
  )
  writeFileSync(
    join(agent, 'settings.json'),
    JSON.stringify({ defaultProvider: 'gate', defaultModel: 'gate', retry: { enabled: false } }),
  )
  const socket = join(root, 'pi.sock')
  const child = spawn(process.execPath, [engine, 'app-server', '--listen', `unix://${socket}`], {
    env: {
      PATH: process.env.PATH,
      HOME: join(root, 'home'),
      TMPDIR: root,
      CHA_PI_HOME: state,
      PI_CODING_AGENT_DIR: agent,
      PI_CLI: join(piPackage, dirname(piEntry), 'cli.js'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let errors = ''
  child.stderr?.on('data', (data) => {
    errors = (errors + data).slice(-4000)
  })
  await until('Pi 运行时起来', () => existsSync(socket), 60_000).catch((error) => {
    throw new Error(`${error.message}\n${errors}`)
  })
  return { child, socket }
}

/** 直接读任务库里的运行记录（不连客户端） */
function storedRuns(stateDir: string): { status: string; summary: string | null }[] {
  const db = new DatabaseSync(join(stateDir, 'tasks.sqlite'), { readOnly: true })
  try {
    return db.prepare('SELECT status, summary FROM runs ORDER BY seq').all() as never
  } finally {
    db.close()
  }
}

test('端到端（Pi）：没有客户端连着时到点跑出会话，模型在任务的回合里调 litch_tasks；客户端回合里调的也由设备答', async () => {
  const root = tempDir()
  const model = await serveModel()
  const { child, socket } = await startPi(root, (model.address() as AddressInfo).port)
  const stateDir = join(root, 'device')
  const work = join(root, 'work')
  mkdirSync(work)
  const clock = new FakeClock()
  const device = new DeviceServer({
    stateDir,
    importExisting: false,
    version: '9.9.9',
    upstreams: [{ id: 'pi', connect: unixConnector(socket) }],
    tasks: { clock },
  })
  try {
    const client = new TestClient(device)
    await client.initialize(DECLARED)
    await until(
      'Pi 可用',
      async () => {
        const info = await client.call('runtime/info')
        return info.harnesses.every((harness: any) => harness.available)
      },
      30_000,
    )
    const { task } = await client.call('litch/task/create', {
      name: '整理日报',
      prompt: '把今天的提交整理成日报。',
      schedule: { type: 'interval', minutes: 5 },
      timezone: 'Asia/Shanghai',
      target: {
        kind: 'newThread',
        harness: 'pi',
        cwd: work,
        workspaceId: null,
        settings: { model: null, effort: null, permission: null },
      },
    })
    client.close()
    await until('客户端都断开了', () => device.connections === 0)

    clock.advance(5 * MINUTE)
    await until(
      '没有客户端时跑完',
      () => storedRuns(stateDir).some((run) => run.status === 'succeeded'),
      60_000,
    )
    assert.equal(device.connections, 0)
    const [stored] = storedRuns(stateDir)
    // 模型调了 litch_tasks.list，设备答的是这台设备上的任务
    assert.match(String(stored?.summary), /^工具答复：\{"tasks":\[\{"id":"/)
    assert.ok(String(stored?.summary).includes(task.id))

    const later = new TestClient(device)
    await later.initialize(DECLARED)
    const [run] = (await later.call('litch/task/runs/list', {})).data
    assert.equal(run.status, 'succeeded')
    assert.equal(run.read, false)
    const list = await later.call('thread/list', {})
    const thread = list.data.find((item: any) => item.id === run.threadId)
    assert.ok(thread, 'thread/list 里看得到任务跑出来的会话')
    assert.equal(thread.harness, 'pi')
    assert.match(String(thread.name), /^整理日报 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)

    // 客户端发起的回合：模型调 litch_tasks.create，设备经这条连接的上游答
    const started = await later.call('thread/start', {
      harness: 'pi',
      cwd: work,
      dynamicTools: [TASKS_TOOLS],
    })
    const threadId = started.thread.id
    await later.call('turn/start', { threadId, input: [{ type: 'text', text: '建个任务' }] })
    const completed = await later.waitFor(
      (frame) => frame.method === 'turn/completed' && (frame.params as any).threadId === threadId,
      60_000,
    )
    assert.equal((completed.params as any).turn.status, 'completed')
    assert.equal(
      later.requests.filter((frame) => frame.method === 'item/tool/call').length,
      0,
      '客户端收不到 litch_tasks 的调用',
    )
    const tasks = (await later.call('litch/task/list', {})).data
    const made = tasks.find((item: any) => item.name === '喝水')
    assert.ok(made, '模型建的任务在列表里')
    assert.deepEqual(made.target, { kind: 'thread', harness: 'pi', threadId })
    assert.deepEqual(made.origin, { kind: 'tool', harness: 'pi', threadId })
    later.close()
  } finally {
    await device.close()
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
    await new Promise((resolve) => model.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
})
