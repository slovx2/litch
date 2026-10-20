// 进程内的假上游：按 JSON-RPC 应答，方法表可以由测试改。一个假上游可以被连上很多次，每次是一条独立的连接。
import type { Connector, WireHandlers } from '../src/wire.mjs'

export interface FakeThread {
  id: string
  updatedAt: number
  [key: string]: unknown
}

export interface FakeProject {
  id: string
  name: string
  roots: { path: string }[]
  metadata: Record<string, string>
  position: number
  createdAt: number
  updatedAt: number
  recencyAt: number | null
}

/** 造一个引擎里的项目 */
export function fakeProject(
  id: string,
  name: string,
  roots: string[],
  more: Partial<FakeProject> = {},
): FakeProject {
  return {
    id,
    name,
    roots: roots.map((path) => ({ path })),
    metadata: {},
    position: 0,
    createdAt: 1000,
    updatedAt: 1000,
    recencyAt: null,
    ...more,
  }
}

/** 置顶用的那个固定的分区，各引擎报的都是这个形状 */
export const FAKE_PINNED = {
  id: '01984de2-8f74-7c91-a3b2-5c5e937cf318',
  name: 'Pinned',
  appearance: null,
}

/** 偏移量当游标的翻页 */
function offsetPage<T>(rows: T[], params: any): { data: T[]; nextCursor: string | null } {
  const limit = params.limit ?? 50
  const start = params.cursor ? Number(Buffer.from(params.cursor, 'base64url').toString()) : 0
  if (!Number.isInteger(start)) throw new RpcFailure(-32602, '游标无效')
  const data = rows.slice(start, start + limit)
  const end = start + data.length
  return {
    data,
    nextCursor: end < rows.length ? Buffer.from(String(end)).toString('base64url') : null,
  }
}

export class RpcFailure extends Error {
  readonly code: number
  /** 错误里带的 data（真的 codex 写配置被拒时带 config_write_error_code）。不给就不带 */
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

type Handler = (params: any, connection: FakeConnection) => unknown

/** 假上游这一头的一条连接 */
export class FakeConnection {
  /** 收到的每一帧的原文 */
  readonly raw: string[] = []
  /** 收到的客户端应答（对服务端请求的答复） */
  readonly answers: any[] = []
  open = true
  private readonly handlers: WireHandlers

  constructor(handlers: WireHandlers) {
    this.handlers = handlers
  }

  /** 以上游的身份发一帧。text 给了就原样发这个原文 */
  send(frame: unknown, text = JSON.stringify(frame)): void {
    queueMicrotask(() => {
      if (this.open) this.handlers.message(text)
    })
  }

  /** 从上游这一头断开 */
  drop(): void {
    if (!this.open) return
    this.open = false
    queueMicrotask(() => this.handlers.close('假上游断开'))
  }
}

export class FakeUpstream {
  readonly connections: FakeConnection[] = []
  /** 收到过的请求和通知，按到达顺序 */
  readonly seen: { method: string; params: any; id: unknown }[] = []
  /** true 时连不上 */
  down = false
  /** 运行时报的引擎名。null 表示它不认识 runtime/info（像原生 codex） */
  engine: string | null
  version = '1.2.3'
  threads: FakeThread[] = []
  /**
   * 这个引擎自己那一份项目存储（官方桌面端在它的入口上用的）。null：它没有这组方法。
   * 聚合面只在导入时读它，从不写它
   */
  projects: FakeProject[] | null = null
  /** 这个引擎自己的自定义分区。null：它没有这组方法 */
  sections: { id: string; name: string; appearance: unknown }[] | null = null
  /** 运行时在 `runtime/info` 里多报的字段（结构化声明等） */
  declaration: Record<string, unknown> = {}
  /** 测试可以往里加方法，或者盖掉默认的 */
  readonly handlers: Record<string, Handler>
  /** 对不认识的方法回什么错误。适配器的运行时回标准的“方法不存在”；假的原生 codex（fake-codex.mts）会换掉它 */
  unknownMethod: (method: string) => { code: number; message: string } = (method) => ({
    code: -32601,
    message: `不支持 ${method}`,
  })
  private created = 0

  constructor(engine: string | null, threads: FakeThread[] = []) {
    this.engine = engine
    this.threads = threads
    this.handlers = {
      initialize: () => ({
        // 适配器的运行时在这里报的是协议版本；原生 codex 报的是它自己的版本
        userAgent: engine
          ? `fake/0.163.0 (test; test) ${engine}`
          : 'codex_cli_rs/9.8.7 (test; test)',
        codexHome: '/fake/home',
        platformFamily: 'unix',
        platformOs: 'test',
      }),
      'runtime/info': () => {
        if (this.engine === null) throw new RpcFailure(-32600, 'Invalid request')
        return {
          engine: this.engine,
          protocolVersion: '0.163.0',
          cliBuild: this.version,
          capabilities: [],
          releaseReady: false,
          ...this.declaration,
        }
      },
      'project/list': (params) => {
        if (this.projects === null) throw new RpcFailure(-32601, '不支持 project/list')
        return offsetPage(
          [...this.projects].sort((a, b) => a.position - b.position),
          params,
        )
      },
      'threadSection/list': (params) => {
        if (this.sections === null) throw new RpcFailure(-32601, '不支持 threadSection/list')
        return offsetPage([FAKE_PINNED, ...this.sections], params)
      },
      'thread/list': (params) => this.page(params),
      'thread/read': (params) => {
        const thread = this.threads.find((item) => item.id === params.threadId)
        if (!thread) throw new RpcFailure(-32602, '未知会话')
        return { thread: { ...thread, turns: [] } }
      },
      'thread/resume': (params) => {
        const thread = this.threads.find((item) => item.id === params.threadId)
        if (!thread) throw new RpcFailure(-32602, '未知会话')
        return { thread: { ...thread, turns: [] }, model: 'fake' }
      },
      'thread/start': (params) => {
        const thread = {
          id: `${this.engine ?? 'codex'}-new-${++this.created}`,
          updatedAt: 9000 + this.created,
          cwd: params.cwd ?? '/',
          ephemeral: params.ephemeral === true,
        }
        this.threads.push(thread)
        return { thread: { ...thread, turns: [] }, model: 'fake' }
      },
      'thread/fork': (params) => {
        const parent = this.find(params.threadId)
        const thread = {
          ...parent,
          id: `${parent.id}-fork-${++this.created}`,
          forkedFromId: parent.id,
          updatedAt: 9000 + this.created,
        }
        this.threads.push(thread)
        return { thread: { ...thread, turns: [] }, model: 'fake' }
      },
      // 引擎自己的实现：别的字段（git 信息等）它收下并存起来。聚合面不该把归属带到这里来
      'thread/metadata/update': (params) => {
        const thread = this.find(params.threadId)
        if (params.gitInfo) thread.gitInfo = { ...(thread.gitInfo as object), ...params.gitInfo }
        return { thread: { ...thread, turns: [] } }
      },
      'thread/delete': (params) => {
        this.find(params.threadId)
        this.threads = this.threads.filter((item) => item.id !== params.threadId)
        return {}
      },
      'thread/archive': (params) => {
        this.find(params.threadId).archived = true
        return {}
      },
      'thread/unarchive': (params) => {
        const thread = this.find(params.threadId)
        thread.archived = false
        return { thread: { ...thread, turns: [] } }
      },
      'turn/start': (params) => ({
        turn: { id: `turn-of-${params.threadId}`, status: 'inProgress' },
      }),
      'model/list': () => ({ data: [{ id: `${this.engine}-model` }], nextCursor: null }),
    }
  }

  private find(threadId: unknown): FakeThread {
    const thread = this.threads.find((item) => item.id === threadId)
    if (!thread) throw new RpcFailure(-32602, '未知会话')
    return thread
  }

  readonly connector: Connector = (handlers) => {
    // 和系统给的错误一个样：带错误码，原文里有套接字的路径
    if (this.down)
      return Promise.reject(
        Object.assign(new Error(`connect ENOENT /fake/state/${this.engine}/runtime.sock`), {
          code: 'ENOENT',
        }),
      )
    const connection = new FakeConnection(handlers)
    this.connections.push(connection)
    return Promise.resolve({
      send: (text: string) => queueMicrotask(() => this.receive(connection, text)),
      close: () => {
        connection.open = false
      },
    })
  }

  /** 现在还连着的连接 */
  get live(): FakeConnection[] {
    return this.connections.filter((connection) => connection.open)
  }

  /** 向所有连着的连接发一个通知 */
  notify(method: string, params?: unknown): void {
    for (const connection of this.live) connection.send({ method, params })
  }

  /** 把所有连接从上游这一头断开（运行时崩了） */
  crash(): void {
    this.down = true
    for (const connection of this.live) connection.drop()
  }

  private page(params: any): unknown {
    const rows = [...this.threads]
      .filter((thread) => thread.ephemeral !== true)
      .filter((thread) => (params.archived === true) === (thread.archived === true))
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
    return { ...offsetPage(rows, params), backwardsCursor: null }
  }

  private receive(connection: FakeConnection, text: string): void {
    if (!connection.open) return
    connection.raw.push(text)
    const frame = JSON.parse(text)
    if (typeof frame.method !== 'string') {
      connection.answers.push(frame)
      return
    }
    this.seen.push({ method: frame.method, params: frame.params, id: frame.id })
    if (frame.id === undefined) return
    const handler = this.handlers[frame.method]
    if (!handler) {
      connection.send({ id: frame.id, error: this.unknownMethod(frame.method) })
      return
    }
    try {
      const result = handler(frame.params ?? {}, connection)
      // 返回 undefined 表示故意不应答
      if (result !== undefined) connection.send({ id: frame.id, result })
    } catch (error) {
      const failure = error as RpcFailure
      connection.send({
        id: frame.id,
        error: {
          code: failure.code ?? -32603,
          message: failure.message,
          ...(failure.data === undefined ? {} : { data: failure.data }),
        },
      })
    }
  }
}
