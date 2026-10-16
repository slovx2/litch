import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexClaudeAppServer } from '../../src/server.mjs'
import { SessionStore } from '../../src/store.mjs'
import type {
  ClaudeRuntime,
  RpcPeer,
  RuntimeHandlers,
  RuntimeSessionHandlers,
  RuntimeTurnContext,
} from '../../src/types.mjs'

// 进程内的服务对象加一个照剧本走的运行时：不起 CLI、不连模型，
// 只看协议层怎么把一个会话的通知和请求分给订阅它的各条连接。

export type TurnScript = (context: RuntimeTurnContext, handlers: RuntimeHandlers) => Promise<void>

// 一条连接。服务端发来的请求不自动回答，由用例决定谁答、什么时候答。
export class Connection {
  readonly name: string
  readonly trace: any[] = []
  readonly peer: RpcPeer
  private readonly server: CodexClaudeAppServer
  private sequence = 0

  constructor(server: CodexClaudeAppServer, name: string) {
    this.server = server
    this.name = name
    this.peer = { id: name, close: () => {}, send: (message) => void this.trace.push(message) }
  }

  // 发一个请求，返回对面的应答（result 或 error 原样在里面）。
  async raw(method: string, params: unknown = {}): Promise<any> {
    const id = `${this.name}:${++this.sequence}`
    await this.server.handle(this.peer, { id, method, params })
    const reply = this.trace.find((message) => message.id === id && !message.method)
    if (!reply) throw new Error(`${this.name} 没有收到 ${method} 的应答`)
    return reply
  }

  async request(method: string, params: unknown = {}): Promise<any> {
    const reply = await this.raw(method, params)
    if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`)
    return reply.result
  }

  // 回答一条服务端请求。
  answer(request: { id: unknown }, result: unknown): Promise<void> {
    return this.server.handle(this.peer, { jsonrpc: '2.0', id: request.id, result } as any)
  }

  notifications(method?: string): any[] {
    return this.trace.filter(
      (message) =>
        message.method && message.id === undefined && (!method || message.method === method),
    )
  }

  // 服务端发来的请求。
  requests(method?: string): any[] {
    return this.trace.filter(
      (message) =>
        message.method && message.id !== undefined && (!method || message.method === method),
    )
  }

  async until<T>(what: string, find: () => T | undefined, timeoutMs = 5_000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = find()
      if (found !== undefined) return found
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(
      `${this.name} 等待超时：${what}\n${JSON.stringify(this.trace.slice(-8), null, 1)}`,
    )
  }

  serverRequest(method: string): Promise<any> {
    return this.until(`服务端请求 ${method}`, () => this.requests(method)[0])
  }

  notification(method: string, match: (params: any) => boolean = () => true): Promise<any> {
    return this.until(`通知 ${method}`, () =>
      this.notifications(method).find((message) => match(message.params)),
    )
  }

  async completed(turnId: string): Promise<any> {
    return (await this.notification('turn/completed', (params) => params.turn.id === turnId)).params
      .turn
  }

  disconnect(): void {
    this.server.closePeer(this.peer)
  }
}

export interface Stage {
  server: CodexClaudeAppServer
  store: SessionStore
  directory: string
  // 之后的回合照这个剧本走；用例随时可以换。
  script: TurnScript
  // 运行时“还有进程活着”的线程（看管后台命令的进程）。
  live: Set<string>
  // 协议层让运行时删掉的原生会话记录（临时会话卸载时），按先后。
  deletedSessions: Array<{ sessionId: string; cwd: string }>
  // 运行时回报给协议层的事件入口：CLI 自己开了一轮等。
  session(): RuntimeSessionHandlers
  // 新开一条连接并握手。capabilities 是握手时的 capabilities，默认什么都不声明。
  connect(name: string, capabilities?: Record<string, unknown> | null): Promise<Connection>
  dispose(): Promise<void>
}

export const sayAndFinish =
  (text: string): TurnScript =>
  async (_context, handlers) => {
    await handlers.onEvent({ type: 'text_delta', delta: text })
    await handlers.onEvent({ type: 'completed', success: true, result: text })
  }

export async function openStage(name: string): Promise<Stage> {
  const directory = await mkdtemp(join(tmpdir(), `${name}-`))
  const previousHome = process.env.CHA_CLAUDE_HOME
  process.env.CHA_CLAUDE_HOME = directory
  const store = new SessionStore(join(directory, 'state.sqlite'))
  let handlers: RuntimeSessionHandlers | undefined
  const stage = {
    script: sayAndFinish('好的'),
    live: new Set<string>(),
    deletedSessions: [] as Stage['deletedSessions'],
  } as Stage
  const runtime: ClaudeRuntime = {
    setSessionHandlers: (value) => {
      handlers = value
    },
    liveSessions: () => [...stage.live],
    closeSession: async (threadId) => void stage.live.delete(threadId),
    deleteSession: async (sessionId, cwd) => void stage.deletedSessions.push({ sessionId, cwd }),
    runTurn: (context, turnHandlers) => stage.script(context, turnHandlers),
    steer: async () => {},
    interrupt: async () => {},
    stop: async () => {},
  }
  const server = new CodexClaudeAppServer(store, runtime)
  return Object.assign(stage, {
    server,
    store,
    directory,
    session: () => {
      if (!handlers) throw new Error('运行时还没有拿到会话回调')
      return handlers
    },
    async connect(connectionName: string, capabilities: Record<string, unknown> | null = null) {
      const connection = new Connection(server, connectionName)
      await connection.request('initialize', {
        clientInfo: { name: connectionName, title: null, version: '1.0.0' },
        capabilities,
      })
      // 握手之后的账号与 MCP 状态通知是异步发的，等它们落定再交给用例，免得混进用例要比的片段。
      await new Promise((resolve) => setTimeout(resolve, 20))
      return connection
    },
    async dispose() {
      await server.stop()
      if (previousHome === undefined) delete process.env.CHA_CLAUDE_HOME
      else process.env.CHA_CLAUDE_HOME = previousHome
      await rm(directory, { recursive: true, force: true })
    },
  })
}
