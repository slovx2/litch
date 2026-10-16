#!/usr/bin/env node
// 假的 codex 命令行进程：给“真的适配器主进程加真的设备进程”的端到端用例用（service-codex.test.mts）。
// 主进程怎么对待用户装的 codex，就怎么对待它：先跑 `--version`，再跑 `app-server --listen unix://路径` 常驻。
// 它在那个套接字上照原生 codex app-server 的样子说话（WebSocket，每帧一条 JSON；不认识的方法回“无效请求”；
// 服务端请求的请求号是递增的整数），不碰任何真的 codex 数据，也不发任何模型请求。
//
// 测试靠这几样控制它、观察它：
// - 环境变量 FAKE_CODEX_VERSION：`--version` 和握手应答里报的版本
// - 套接字旁边的 greetings.jsonl：每次握手收到的参数，一行一条（看我们的扩展键有没有带过来）
// - 套接字旁边的 fake-codex.pid：这个进程的进程号
// - 回合：收到 turn/start 就发一条命令审批，客户端答了之后把决定写在回话里，回合结束
import { appendFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { type WebSocket, WebSocketServer } from 'ws'

const VERSION = process.env.FAKE_CODEX_VERSION ?? '0.160.0'
const KNOWN =
  '`initialize`, `thread/start`, `thread/list`, `thread/read`, `turn/start`, `model/list`'

class Failure extends Error {}

interface Thread {
  id: string
  preview: string
  ephemeral: boolean
  modelProvider: string
  createdAt: number
  updatedAt: number
  status: { type: string }
  cwd: string
  cliVersion: string
  name: string | null
  turns: unknown[]
}

function serve(socket: string): void {
  const directory = dirname(socket)
  writeFileSync(join(directory, 'fake-codex.pid'), String(process.pid))
  const threads: Thread[] = []
  const thread = (id: string, updatedAt: number, cwd: string): Thread => {
    const made = {
      id,
      preview: '在终端里开的会话',
      ephemeral: false,
      modelProvider: 'openai',
      createdAt: updatedAt,
      updatedAt,
      status: { type: 'notLoaded' },
      cwd,
      cliVersion: VERSION,
      name: null,
      turns: [],
    }
    threads.push(made)
    return made
  }
  thread('019a0000-0000-7000-8000-00000000c0de', 4_000_000_000, '/work/from-terminal')
  let created = 0
  let nextRequest = 0
  /** 等客户端答复的审批：答了之后接着做什么 */
  const waiting = new Map<number, (result: any) => void>()

  const connection = (ws: WebSocket) => {
    const send = (frame: unknown) => ws.send(JSON.stringify(frame))
    const handlers: Record<string, (params: any) => unknown> = {
      initialize: (params) => {
        appendFileSync(join(directory, 'greetings.jsonl'), `${JSON.stringify(params)}\n`)
        const name = params.clientInfo?.name ?? 'unknown'
        return {
          userAgent: `${name}/${VERSION} (Mac OS 26.5.0; arm64) unknown (${name}; ${params.clientInfo?.version ?? ''})`,
          codexHome: process.env.CODEX_HOME ?? '/fake/codex-home',
          platformFamily: 'unix',
          platformOs: 'macos',
        }
      },
      'permissionProfile/list': () => ({
        data: [':read-only', ':workspace', ':danger-full-access'].map((id) => ({
          id,
          description: null,
          allowed: true,
        })),
        nextCursor: null,
      }),
      'model/list': () => ({ data: [{ id: 'fake-codex-model' }], nextCursor: null }),
      'thread/list': (params) => ({
        data:
          params.archived === true ? [] : [...threads].sort((a, b) => b.updatedAt - a.updatedAt),
        nextCursor: null,
        backwardsCursor: null,
      }),
      'thread/read': (params) => {
        const found = threads.find((item) => item.id === params.threadId)
        if (!found) throw new Failure(`invalid thread id: ${params.threadId}`)
        return { thread: found }
      },
      'thread/start': (params) => {
        const made = thread(
          `019a0000-0000-7000-8000-${String(++created).padStart(12, '0')}`,
          4_000_000_001 + created,
          params.cwd ?? '/',
        )
        return { thread: made, model: 'fake-codex-model', approvalPolicy: 'on-request' }
      },
      'turn/start': (params) => {
        const threadId = params.threadId
        if (!threads.some((item) => item.id === threadId))
          throw new Failure(`thread not found: ${threadId}`)
        const turn = { id: `turn-${threadId.slice(-4)}-${Date.now()}`, status: 'inProgress' }
        setImmediate(() => {
          send({ method: 'turn/started', params: { threadId, turn: { ...turn, items: [] } } })
          const id = nextRequest++
          waiting.set(id, (result) => {
            send({ method: 'serverRequest/resolved', params: { threadId, requestId: id } })
            const text = `决定是 ${JSON.stringify(result?.decision)}，带来的审批策略是 ${params.approvalPolicy ?? '没有'}`
            const item = { type: 'agentMessage', id: 'msg_1', text, phase: 'final_answer' }
            send({ method: 'item/completed', params: { threadId, turnId: turn.id, item } })
            send({
              method: 'turn/completed',
              params: { threadId, turn: { ...turn, status: 'completed', items: [item] } },
            })
          })
          send({
            id,
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId,
              turnId: turn.id,
              itemId: 'call_1',
              startedAtMs: Date.now(),
              environmentId: null,
              command: 'echo hi',
              cwd: '/',
              availableDecisions: ['accept', 'cancel'],
            },
          })
        })
        return { turn: { ...turn, items: [] } }
      },
    }
    ws.on('error', () => {})
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString())
      if (typeof frame.method !== 'string') {
        // 客户端对审批的答复
        const resume = waiting.get(frame.id)
        waiting.delete(frame.id)
        resume?.(frame.result)
        return
      }
      if (frame.id === undefined) return
      const handler = handlers[frame.method]
      try {
        if (!handler)
          throw new Failure(
            `Invalid request: unknown variant \`${frame.method}\`, expected one of ${KNOWN}`,
          )
        send({ id: frame.id, result: handler(frame.params ?? {}) })
      } catch (error) {
        if (!(error instanceof Failure)) throw error
        send({ id: frame.id, error: { code: -32600, message: error.message } })
      }
    })
  }

  const server = http.createServer()
  const sockets = new WebSocketServer({ server, perMessageDeflate: false })
  sockets.on('connection', connection)
  // 主进程探测就绪时只连一下就断，不升级成 WebSocket
  server.on('clientError', (_error, raw) => raw.destroy())
  server.listen(socket, () => process.stderr.write(`fake codex app-server ${VERSION} started\n`))
  const stop = () => {
    for (const ws of sockets.clients) ws.terminate()
    server.close(() => process.exit(0))
    server.closeAllConnections()
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

const argv = process.argv.slice(2)
if (argv.length === 1 && argv[0] === '--version') process.stdout.write(`codex-cli ${VERSION}\n`)
else if (
  argv.length === 3 &&
  argv[0] === 'app-server' &&
  argv[1] === '--listen' &&
  argv[2]?.startsWith('unix://')
)
  serve(argv[2].slice('unix://'.length))
else {
  process.stderr.write(`假的 codex 不认识这样的启动参数：${argv.join(' ')}\n`)
  process.exitCode = 2
}
