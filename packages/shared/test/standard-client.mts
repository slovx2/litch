// 只说标准协议的测试客户端：握手时不声明我们的任何扩展，服务端发来的每一条消息都过严格校验。
// 它不管连接怎么建：各入口的测试把“怎么把一条消息交给服务端”给它，收到服务端的消息时调 accept。
import { type Finding, findingKey, upstreamMethods } from './strict-schema.mjs'
import { inspect, kindOf, requestParamsProblems } from './strict-wire.mjs'

export interface RpcReply {
  result?: any
  error?: { code: number; message: string; data?: unknown }
}

/** 服务端请求的应答：返回 undefined 表示先不答（之后用 respond 答）；抛出的错误按 JSON-RPC 错误回过去 */
export type ServerRequestHandler = (
  method: string,
  params: any,
  id: string | number,
) => unknown | Promise<unknown>

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class StandardClient {
  /** 服务端发来的每一条，线上的样子，按到达的先后 */
  readonly received: any[] = []
  /** 发出去的每一条请求和通知 */
  readonly sent: any[] = []
  /** 与上游结构的出入，同一种只记一条 */
  readonly findings = new Map<string, Finding>()
  /** 每种出入头一次出现时的那条消息，排查用 */
  readonly samples = new Map<string, unknown>()
  /** 测试自己的毛病：发出去的参数不合上游结构、给服务端请求的应答不合上游结构 */
  readonly mistakes: string[] = []
  onServerRequest: ServerRequestHandler | null = null
  requestTimeoutMs = 30_000
  waitTimeoutMs = 45_000
  private sequence = 0
  private readonly methods = new Map<string | number, string>()
  private readonly waiting = new Map<string | number, (reply: RpcReply) => void>()
  private readonly deliver: (message: Record<string, unknown>) => unknown

  constructor(deliver: (message: Record<string, unknown>) => unknown) {
    this.deliver = deliver
  }

  /** 服务端发来了一条消息。进程里的对象先过一遍 JSON，和线上的样子一致 */
  accept(message: unknown): void {
    const wire = JSON.parse(JSON.stringify(message))
    this.received.push(wire)
    for (const finding of inspect(wire, (id) => this.methods.get(id as string | number)))
      this.note(finding, wire)
    const kind = kindOf(wire)
    if (kind === 'response' || kind === 'error') {
      const settle = this.waiting.get(wire.id)
      this.waiting.delete(wire.id)
      settle?.(wire)
    } else if (kind === 'serverRequest') void this.answer(wire)
  }

  /** 记一处出入：同一种只记头一次，连同当时那条消息 */
  note(finding: Finding, sample: unknown): void {
    const key = findingKey(finding)
    if (this.findings.has(key)) return
    this.findings.set(key, finding)
    this.samples.set(key, sample)
  }

  private async answer(request: any): Promise<void> {
    if (!this.onServerRequest) {
      // 标准客户端对不认识的服务端请求：回“方法不存在”，不让对面悬着
      this.send({ id: request.id, error: { code: -32601, message: '测试客户端不处理这个请求' } })
      return
    }
    try {
      const result = await this.onServerRequest(request.method, request.params, request.id)
      if (result !== undefined) this.respond(request.id, result)
    } catch (error) {
      this.send({ id: request.id, error: { code: -32000, message: String(error) } })
    }
  }

  /** 回答一条服务端请求 */
  respond(id: string | number, result: unknown): void {
    this.send({ id, result })
  }

  private send(message: Record<string, unknown>): void {
    this.sent.push(message)
    void this.deliver(message)
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params })
  }

  /**
   * 发一条请求，等它的应答（成功或错误都返回）。到时限还没应答就抛错：这就是“挂住了”。
   * params 不给时消息里不带这个键（上游有些方法的参数就是空的）。
   */
  async request(method: string, params?: unknown): Promise<RpcReply> {
    if (params !== undefined && method in upstreamMethods.clientRequests)
      for (const problem of requestParamsProblems(method, params))
        this.mistakes.push(`发出的 ${method} 参数不合上游结构：${problem}`)
    const id = ++this.sequence
    this.methods.set(id, method)
    const reply = new Promise<RpcReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`${method} 在 ${this.requestTimeoutMs} 毫秒内没有应答`))
      }, this.requestTimeoutMs)
      this.waiting.set(id, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
    })
    this.send(params === undefined ? { id, method } : { id, method, params })
    return reply
  }

  /** 发一条必须成功的请求 */
  async ok(method: string, params?: unknown): Promise<any> {
    const reply = await this.request(method, params)
    if (reply.error) throw new Error(`${method} 被拒绝：${JSON.stringify(reply.error)}`)
    return reply.result
  }

  /** 等一条服务端发来的通知或请求（已经到了的也算），返回整条消息 */
  async until(
    method: string,
    match: (params: any) => boolean = () => true,
    what = method,
  ): Promise<any> {
    for (let waited = 0; waited < this.waitTimeoutMs; waited += 20) {
      const found = this.received.find((entry) => entry.method === method && match(entry.params))
      if (found) return found
      await pause(20)
    }
    const tail = this.received.slice(-6).map((entry) => JSON.stringify(entry).slice(0, 300))
    throw new Error(`等待超时：${what}\n最近收到的：\n${tail.join('\n')}`)
  }

  /** 等一个回合结束，返回回合 */
  async completed(turnId: string): Promise<any> {
    const done = await this.until(
      'turn/completed',
      (params) => params.turn?.id === turnId,
      `回合 ${turnId} 结束`,
    )
    return done.params.turn
  }

  /** 标准握手：不带我们的任何扩展。capabilities 由用例给（上游自己的能力字段） */
  async handshake(
    clientInfo: Record<string, unknown>,
    capabilities: Record<string, unknown> | null,
  ): Promise<any> {
    if (capabilities && 'litchExtensions' in capabilities) throw new Error('标准客户端不声明扩展')
    const result = await this.ok('initialize', { clientInfo, capabilities })
    this.notify('initialized')
    return result
  }

  /** 这条连接上出现过的通知方法 */
  notificationMethods(): string[] {
    return [
      ...new Set(
        this.received
          .filter((entry) => kindOf(entry) === 'notification')
          .map((entry) => entry.method as string),
      ),
    ].sort()
  }

  /** 这条连接上出现过的服务端请求方法 */
  serverRequestMethods(): string[] {
    return [
      ...new Set(
        this.received
          .filter((entry) => kindOf(entry) === 'serverRequest')
          .map((entry) => entry.method as string),
      ),
    ].sort()
  }
}
