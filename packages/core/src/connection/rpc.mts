// 连接层的中间一层的下半部分：在一条传输上跑 JSON-RPC。
// 只管三件事：请求与应答配对（带超时和取消）、把通知交出去、对面发来的请求一定给应答。
import {
  isNotification,
  isRequest,
  isResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  RPC_ERROR,
} from '../../../protocol/src/index.mjs'
import type { AbortSignalLike, Clock } from '../channel/protocol.mjs'
import { describeText, type Text } from '../phrase.mjs'
import type { Transport } from './transport.mjs'

/** 对面明确回了一个错误 */
export class RpcError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }
}

/** 请求没等到应答就结束了：连接断了、超时了，或者调用方取消了 */
export class RpcAbortError extends Error {
  readonly reason: 'closed' | 'timeout' | 'cancelled'

  constructor(reason: 'closed' | 'timeout' | 'cancelled', message: string) {
    super(message)
    this.name = 'RpcAbortError'
    this.reason = reason
  }
}

/**
 * 处理对面请求的一方用它表示“这个请求不用回了”：对面已经通知它在别处有了结果。
 * 其余情况一定要给应答。
 */
export const NO_REPLY: unique symbol = Symbol('no-reply')

export interface RpcRequestOptions {
  signal?: AbortSignalLike
  /** 不给就用连接的默认值；给 0 表示不设超时 */
  timeoutMs?: number
}

export interface RpcOptions {
  clock: Clock
  /** 请求的默认超时，默认 30 秒 */
  requestTimeoutMs?: number
  notification(method: string, params: unknown): void
  /**
   * 对面发来的请求。返回 undefined 表示不处理。
   * 不处理的请求会得到一个“方法不存在”的应答：不应答的话对面的回合会一直挂着（设计文档 01 第十节第 7 条）。
   * id 是这个请求的编号，对面之后用它通知“这个请求已经有结果了”。
   */
  request?(method: string, params: unknown, id: JsonRpcId): Promise<unknown> | undefined
  /** 连接断了。只调用一次 */
  close(reason: Text | null): void
  log?(line: string): void
}

export interface Rpc {
  request(method: string, params: unknown, options?: RpcRequestOptions): Promise<unknown>
  notify(method: string, params?: unknown): void
  close(): void
  readonly closed: boolean
}

interface Pending {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
  stopTimer: (() => void) | null
}

export function createRpc(transport: Transport, options: RpcOptions): Rpc {
  const defaultTimeout = options.requestTimeoutMs ?? 30_000
  const pending = new Map<JsonRpcId, Pending>()
  let nextId = 1
  let closed = false

  const send = (message: JsonRpcMessage) => {
    if (!closed) transport.send(JSON.stringify(message))
  }

  const settle = (id: JsonRpcId): Pending | undefined => {
    const entry = pending.get(id)
    if (!entry) return undefined
    pending.delete(id)
    entry.stopTimer?.()
    return entry
  }

  const answer = (id: JsonRpcId, method: string, params: unknown) => {
    let handled: Promise<unknown> | undefined
    try {
      handled = options.request?.(method, params, id)
    } catch (error) {
      handled = Promise.reject(error)
    }
    if (!handled) {
      options.log?.(`对面发来了客户端不处理的请求：${method}`)
      send({ id, error: { code: RPC_ERROR.methodNotFound, message: `客户端不处理 ${method}` } })
      return
    }
    handled.then(
      (result) => {
        if (result !== NO_REPLY) send({ id, result: result ?? {} })
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        send({ id, error: { code: RPC_ERROR.internalError, message } })
      },
    )
  }

  const receive = (text: string) => {
    let message: JsonRpcMessage
    try {
      message = JSON.parse(text) as JsonRpcMessage
    } catch {
      options.log?.(`收到一帧不是 JSON 的内容，已丢弃（${text.length} 个字符）`)
      return
    }
    if (typeof message !== 'object' || message === null) return
    if (isRequest(message)) {
      answer(message.id, message.method, message.params)
    } else if (isNotification(message)) {
      options.notification(message.method, message.params)
    } else if (isResponse(message)) {
      // 编号为空的错误应答是对面在说“你发的东西我解析不了”，配不上任何请求，只能记下来
      const entry = message.id === null ? undefined : settle(message.id)
      if (!entry) {
        if ('error' in message)
          options.log?.(`对面报错（没有对应的请求）：${message.error.message}`)
        return
      }
      if ('error' in message) {
        const { code, message: text, data } = message.error
        entry.reject(new RpcError(code, text, data))
      } else {
        entry.resolve(message.result)
      }
    }
  }

  const shutdown = (reason: Text | null) => {
    if (closed) return
    closed = true
    const error = new RpcAbortError('closed', reason ? describeText(reason) : '连接已经关闭')
    for (const id of [...pending.keys()]) settle(id)?.reject(error)
    options.close(reason)
  }

  transport.listen({ message: receive, close: shutdown })

  return {
    get closed() {
      return closed
    },

    request(method, params, requestOptions) {
      if (closed) return Promise.reject(new RpcAbortError('closed', '连接已经关闭'))
      const signal = requestOptions?.signal
      if (signal?.aborted) return Promise.reject(new RpcAbortError('cancelled', '已取消'))
      const id = nextId++
      const timeoutMs = requestOptions?.timeoutMs ?? defaultTimeout
      return new Promise<unknown>((resolve, reject) => {
        const entry: Pending = { method, resolve, reject, stopTimer: null }
        if (timeoutMs > 0) {
          entry.stopTimer = options.clock.setTimer(() => {
            if (settle(id))
              reject(new RpcAbortError('timeout', `${method} 超过 ${timeoutMs} 毫秒没有应答`))
          }, timeoutMs)
        }
        pending.set(id, entry)
        // 协议里没有“取消请求”这回事，取消只是这一头不再等
        signal?.addEventListener(
          'abort',
          () => {
            if (settle(id)) reject(new RpcAbortError('cancelled', '已取消'))
          },
          { once: true },
        )
        send(params === undefined ? { id, method } : { id, method, params })
      })
    },

    notify(method, params) {
      send(params === undefined ? { method } : { method, params })
    },

    close() {
      if (closed) return
      transport.close()
      // 传输的实现应当回调 close；这里兜一下，保证等待中的请求一定会结束
      shutdown(null)
    },
  }
}
