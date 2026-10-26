// 会话树的测试用的假引擎：在 fake-upstream.mts 上补齐回合（turn/start、turn/steer、turn/interrupt，测试决定什么时候结束）、
// 会话的状态和回合记录、thread/resume 报的权限设置，以及适配器入口挑客户端工具执行方的规矩：
// litch_ 命名空间的 item/tool/call 交给发起这个回合、握手时声明了它的连接，否则交给订阅着会话（thread/start、
// thread/fork、thread/resume 订阅，thread/unsubscribe 退订）、声明了它的连接里最早订阅的那条，都没有就挑不出来。
// 通知发给所有连着的连接（真的引擎只发给订阅者；这里不区分，够测设备进程的去重）。
import { type FakeConnection, type FakeThread, FakeUpstream, RpcFailure } from './fake-upstream.mjs'

export interface FakeTurn {
  id: string
  status: 'inProgress' | 'completed' | 'failed' | 'interrupted'
  items: Record<string, unknown>[]
  error: { message: string } | null
}

export class FakeEngine extends FakeUpstream {
  /** 每条连接握手时带来的参数 */
  readonly greetings = new Map<FakeConnection, any>()
  /** 每个会话的回合 */
  readonly turns = new Map<string, FakeTurn[]>()
  /** 发起每个回合的连接 */
  readonly starters = new Map<string, FakeConnection>()
  /** 每个会话订阅着的连接，按订阅的先后 */
  readonly subscribers = new Map<string, FakeConnection[]>()
  /** thread/resume 报的审批策略和沙箱 */
  config: { approvalPolicy: unknown; sandbox: unknown } = {
    approvalPolicy: 'on-request',
    sandbox: { type: 'workspaceWrite' },
  }
  private serial = 0
  private requestSerial = 0

  constructor(engine: string, threads: FakeThread[] = []) {
    super(engine, threads)
    this.declaration = { extensions: ['clientTools'] }
    const greet = this.handlers.initialize as NonNullable<(typeof this.handlers)[string]>
    this.handlers.initialize = (params, connection) => {
      this.greetings.set(connection, params)
      return greet(params, connection)
    }
    const withState = (thread: FakeThread) => ({
      ...thread,
      status: this.running(thread.id) ? { type: 'active', activeFlags: [] } : { type: 'idle' },
    })
    this.handlers['thread/start'] = (params, connection) => {
      const thread: FakeThread = {
        id: `${engine}-t${++this.serial}`,
        updatedAt: 9000 + this.serial,
        cwd: params.cwd ?? '/work',
        preview: '',
        name: null,
        parentThreadId: null,
        ephemeral: false,
      }
      this.threads.push(thread)
      this.subscribe(thread.id, connection)
      return {
        thread: { ...withState(thread), turns: [] },
        model: 'fake',
        cwd: thread.cwd,
        ...this.config,
      }
    }
    this.handlers['thread/fork'] = (params, connection) => {
      const parent = this.thread(params.threadId)
      const thread = { ...parent, id: `${parent.id}-fork${++this.serial}`, forkedFromId: parent.id }
      this.threads.push(thread)
      this.subscribe(thread.id, connection)
      return { thread: { ...withState(thread), turns: [] }, model: 'fake', ...this.config }
    }
    this.handlers['thread/resume'] = (params, connection) => {
      const thread = this.thread(params.threadId)
      this.subscribe(thread.id, connection)
      return {
        thread: { ...withState(thread), turns: [] },
        model: 'fake',
        cwd: thread.cwd,
        ...this.config,
      }
    }
    this.handlers['thread/unsubscribe'] = (params, connection) => {
      const list = this.subscribers.get(params.threadId) ?? []
      this.subscribers.set(
        params.threadId,
        list.filter((one) => one !== connection),
      )
      return { status: 'unsubscribed' }
    }
    this.handlers['thread/read'] = (params) => {
      const thread = this.thread(params.threadId)
      const turns = params.includeTurns ? (this.turns.get(thread.id) ?? []) : []
      return { thread: { ...withState(thread), turns: structuredClone(turns) } }
    }
    this.handlers['thread/list'] = (params) => ({
      data: this.threads
        .filter((thread) => !params.cwd || thread.cwd === params.cwd)
        .map((thread) => withState(thread)),
      nextCursor: null,
      backwardsCursor: null,
    })
    this.handlers['turn/start'] = (params, connection) => {
      const thread = this.thread(params.threadId)
      if (this.running(thread.id)) throw new RpcFailure(-32600, '已经有回合在跑')
      const turn: FakeTurn = {
        id: `${thread.id}-turn${++this.serial}`,
        status: 'inProgress',
        items: [{ type: 'userMessage', id: `u${this.serial}`, content: params.input }],
        error: null,
      }
      this.turns.set(thread.id, [...(this.turns.get(thread.id) ?? []), turn])
      this.starters.set(turn.id, connection)
      if (!thread.preview) thread.preview = String(params.input?.[0]?.text ?? '').slice(0, 40)
      queueMicrotask(() =>
        this.notify('turn/started', { threadId: thread.id, turn: { ...turn, items: [] } }),
      )
      return { turn: { ...turn, items: [] } }
    }
    this.handlers['turn/steer'] = (params) => {
      const turn = this.current(params.threadId)
      if (!turn || turn.id !== params.expectedTurnId)
        throw new RpcFailure(-32600, '没有这个回合在跑')
      turn.items.push({ type: 'userMessage', id: `s${++this.serial}`, content: params.input })
      return { turnId: turn.id }
    }
    this.handlers['turn/interrupt'] = (params) => {
      const turn = this.current(params.threadId)
      if (!turn || turn.id !== params.turnId) throw new RpcFailure(-32600, '没有这个回合在跑')
      this.end(params.threadId, 'interrupted')
      return {}
    }
    // 归档在跑的会话：回合先被打断，再发 thread/archived（适配器入口的做法）
    this.handlers['thread/archive'] = (params) => {
      const thread = this.thread(params.threadId)
      if (this.running(thread.id)) this.end(thread.id, 'interrupted')
      thread.archived = true
      queueMicrotask(() => this.notify('thread/archived', { threadId: thread.id }))
      return {}
    }
  }

  private subscribe(threadId: string, connection: FakeConnection): void {
    const list = this.subscribers.get(threadId) ?? []
    if (!list.includes(connection)) this.subscribers.set(threadId, [...list, connection])
  }

  thread(threadId: unknown): FakeThread {
    const thread = this.threads.find((item) => item.id === threadId)
    if (!thread) throw new RpcFailure(-32602, `thread not found: ${String(threadId)}`)
    return thread
  }

  current(threadId: string): FakeTurn | null {
    const turn = this.turns.get(threadId)?.at(-1)
    return turn?.status === 'inProgress' ? turn : null
  }

  running(threadId: string): boolean {
    return this.current(threadId) !== null
  }

  /** 引擎自己开一个回合（没有发起的连接，比如 CLI 把后台命令的结果告诉模型） */
  selfTurn(threadId: string): FakeTurn {
    const turn: FakeTurn = {
      id: `${threadId}-self${++this.serial}`,
      status: 'inProgress',
      items: [],
      error: null,
    }
    this.turns.set(threadId, [...(this.turns.get(threadId) ?? []), turn])
    this.notify('turn/started', { threadId, turn: { ...turn, items: [] } })
    return turn
  }

  /** 结束会话正在跑的回合，带一条回答；失败、打断的可以带上回合的错误 */
  end(
    threadId: string,
    status: FakeTurn['status'] = 'completed',
    answer?: string,
    error?: string,
  ): FakeTurn {
    const turn = this.current(threadId)
    if (!turn) throw new Error(`${threadId} 没有回合在跑`)
    if (error !== undefined) turn.error = { message: error }
    if (answer !== undefined) {
      const item = { type: 'agentMessage', id: `a${++this.serial}`, text: answer }
      turn.items.push(item)
      this.notify('item/completed', { threadId, turnId: turn.id, item })
    }
    turn.status = status
    this.notify('turn/completed', { threadId, turn: { ...turn, items: [] } })
    return turn
  }

  /** 这条连接握手时声明能执行的命名空间 */
  declared(connection: FakeConnection): string[] {
    const capabilities = this.greetings.get(connection)?.capabilities ?? {}
    if (!(capabilities.litchExtensions ?? []).includes('clientTools')) return []
    return capabilities.litchClientTools?.namespaces ?? []
  }

  /**
   * 模型调一次 litch_ 命名空间的工具：照适配器的规矩挑一条连接发 item/tool/call，等它答。
   * 挑不出来时返回 null
   */
  async callTool(
    threadId: string,
    namespace: string,
    tool: string,
    args: unknown,
  ): Promise<{ connection: FakeConnection; answer: any } | null> {
    const turn = this.turns.get(threadId)?.at(-1)
    const starter = turn ? this.starters.get(turn.id) : undefined
    const connection =
      starter?.open && this.declared(starter).includes(namespace)
        ? starter
        : (this.subscribers.get(threadId) ?? []).find(
            (one) => one.open && this.declared(one).includes(namespace),
          )
    if (!connection) return null
    const id = `req-${++this.requestSerial}`
    const before = connection.answers.length
    connection.send({
      id,
      method: 'item/tool/call',
      params: {
        threadId,
        turnId: turn?.id ?? '',
        callId: `call-${id}`,
        namespace,
        tool,
        arguments: args,
      },
    })
    for (let waited = 0; waited < 5000; waited += 5) {
      const answer = connection.answers.slice(before).find((frame) => frame.id === id)
      if (answer) return { connection, answer }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`${namespace}.${tool} 等了 5 秒没有答复`)
  }

  /** 发一个审批请求给所有连接（像订阅着这个会话的都收到） */
  approval(threadId: string): string {
    const id = `approve-${++this.requestSerial}`
    const turn = this.current(threadId)
    this.notifyRequest(id, 'item/commandExecution/requestApproval', {
      threadId,
      turnId: turn?.id ?? '',
      itemId: 'cmd',
      command: 'rm -rf build',
    })
    return id
  }

  private notifyRequest(id: string, method: string, params: unknown): void {
    for (const connection of this.live) connection.send({ id, method, params })
  }

  /** 收到过的某个方法的参数 */
  sent(method: string): any[] {
    return this.seen.filter((item) => item.method === method).map((item) => item.params)
  }
}

/** 一段 litch_ 工具答复里的 JSON（成功时） */
export function resultOf(answer: any): any {
  const text = answer?.result?.contentItems?.[0]?.text
  if (answer?.result?.success !== true) throw new Error(`工具调用没成功：${text}`)
  return JSON.parse(text)
}

/** 失败答复的第一行种类，[litch:<kind>] 里的 kind */
export function failureOf(answer: any): string {
  const text: string = answer?.result?.contentItems?.[0]?.text ?? ''
  if (answer?.result?.success !== false) throw new Error(`工具调用应该失败，却成功了：${text}`)
  return /^\[litch:(\w+)\]/.exec(text)?.[1] ?? text
}
