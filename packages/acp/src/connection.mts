// 和 ACP agent 之间的一条连接：agent 进程的标准输入输出上逐行一条 JSON-RPC 2.0 消息（ndjson）。
// 两个方向都有请求：我们问 agent（initialize、session/*），agent 也反过来问我们（权限、读写文件、终端）。
// 不用官方 SDK：线上就这么点规矩，自己写少一层依赖，消息的先后也看得清（见 receive）。
import type { Readable, Writable } from 'node:stream'

export interface RpcFailure {
  code: number
  message: string
  data?: unknown
}

/** agent 回的错误，或者连接断了。code 是 JSON-RPC 的错误码，连接断了的是 -32000 */
export class AcpError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

/** agent 反过来问我们时，处理函数抛出它就回这个错误码；抛别的回 -32603 */
export class HandlerError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

export interface ConnectionHandlers {
  /** agent 发来的请求。返回值就是应答的 result */
  request(method: string, params: any): Promise<unknown>
  /** agent 发来的通知（session/update 等）。同步处理：同一行之后的消息要等它处理完 */
  notification(method: string, params: any): void
}

interface Waiting {
  method: string
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
}

export class AcpConnection {
  private readonly output: Writable
  private readonly handlers: ConnectionHandlers
  private readonly waiting = new Map<number, Waiting>()
  private sequence = 0
  private buffer = ''
  private ended: Error | null = null

  constructor(input: Readable, output: Writable, handlers: ConnectionHandlers) {
    this.output = output
    this.handlers = handlers
    input.setEncoding('utf8')
    input.on('data', (chunk: string) => this.receive(chunk))
    // 写失败（agent 已经退出、管道断了）由 close 统一收场，这里只别让它变成未处理的异常
    output.on('error', () => {})
  }

  get closed(): boolean {
    return this.ended !== null
  }

  /** 向 agent 发一个请求。timeoutMs 不给就一直等（session/prompt 要等到回合结束） */
  request<T = any>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.ended) return Promise.reject(this.ended)
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? null
          : setTimeout(() => {
              this.waiting.delete(id)
              reject(new AcpError(-32000, `ACP agent 没有在 ${timeoutMs} 毫秒内应答 ${method}`))
            }, timeoutMs)
      this.waiting.set(id, { method, resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    if (!this.ended) this.write({ jsonrpc: '2.0', method, params })
  }

  /** 连接到头了（进程退出、管道关了）：还在等的请求一律以 reason 失败 */
  close(reason: Error): void {
    if (this.ended) return
    this.ended = reason
    for (const [id, entry] of this.waiting) {
      if (entry.timer) clearTimeout(entry.timer)
      this.waiting.delete(id)
      entry.reject(reason)
    }
  }

  private write(message: unknown): void {
    try {
      this.output.write(`${JSON.stringify(message)}\n`)
    } catch {}
  }

  // 一块一块收，凑满一行处理一行。通知当场同步处理，应答经 Promise 交出去：同一块里先到的更新，
  // 一定在随后那个应答的等待者醒来之前处理完（agent 在回 session/prompt 之前发完这一回合的更新，
  // 回 session/load 之前发完回放），先后不会乱。
  private receive(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.dispatch(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private dispatch(line: string): void {
    let message: any
    try {
      message = JSON.parse(line)
    } catch {
      // agent 往标准输出里写了不是 JSON 的东西（日志之类）：不是协议消息，丢掉
      return
    }
    if (!message || typeof message !== 'object') return
    const hasId = message.id !== undefined && message.id !== null
    if (typeof message.method === 'string') {
      if (hasId) void this.answer(message.id, message.method, message.params)
      else
        try {
          this.handlers.notification(message.method, message.params)
        } catch {}
      return
    }
    if (!hasId) return
    const entry = this.waiting.get(Number(message.id))
    if (!entry) return
    this.waiting.delete(Number(message.id))
    if (entry.timer) clearTimeout(entry.timer)
    if (message.error)
      entry.reject(
        new AcpError(
          Number(message.error.code ?? -32603),
          String(message.error.message ?? `${entry.method} 失败`),
          message.error.data,
        ),
      )
    else entry.resolve(message.result ?? null)
  }

  private async answer(id: unknown, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.handlers.request(method, params ?? {})
      this.write({ jsonrpc: '2.0', id, result: result ?? null })
    } catch (error) {
      const code = error instanceof HandlerError ? error.code : -32603
      const message = error instanceof Error ? error.message : String(error)
      this.write({ jsonrpc: '2.0', id, error: { code, message } })
    }
  }
}
