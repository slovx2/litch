// 测试用的假对端：在一条传输上按 JSON-RPC 应答，方法表由测试给。
import type { JsonRpcMessage } from '../../protocol/src/index.mjs'
import { createTransportPair, type Transport, type TransportOpener } from '../src/index.mjs'

export type Handler = (params: unknown) => unknown

export class RpcFailure extends Error {
  readonly code: number
  /** 错误里附带的数据。聚合面自己回的错误在这里说明原因 */
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

export interface FakeServer {
  /** 收到过的请求和通知，按到达顺序 */
  readonly seen: { method: string; params: unknown }[]
  notify(method: string, params?: unknown): void
  /** 以对面的身份发一个请求，返回客户端给的应答。id 不给就自己编一个 */
  ask(method: string, params?: unknown, id?: string | number): Promise<JsonRpcMessage>
  /** 从对面这一头断开 */
  drop(): void
}

export function serveFake(transport: Transport, handlers: Record<string, Handler>): FakeServer {
  const seen: { method: string; params: unknown }[] = []
  const waiting = new Map<string, (message: JsonRpcMessage) => void>()
  let askId = 0
  transport.listen({
    message(text) {
      const message = JSON.parse(text) as JsonRpcMessage
      if (!('method' in message)) {
        waiting.get(String(message.id))?.(message)
        waiting.delete(String(message.id))
        return
      }
      seen.push({ method: message.method, params: message.params })
      if (!('id' in message)) return
      const handler = handlers[message.method]
      if (!handler) {
        const error = { code: -32601, message: `Method not found: ${message.method}` }
        transport.send(JSON.stringify({ id: message.id, error }))
        return
      }
      const fail = (error: unknown) => {
        const failure = error as RpcFailure
        transport.send(
          JSON.stringify({
            id: message.id,
            error: {
              code: failure.code ?? -32603,
              message: failure.message,
              ...(failure.data === undefined ? {} : { data: failure.data }),
            },
          }),
        )
      }
      // 返回 undefined 表示故意不应答，用来测超时
      const reply = (result: unknown) => {
        if (result !== undefined) transport.send(JSON.stringify({ id: message.id, result }))
      }
      try {
        const result = handler(message.params)
        // 返回一个还没兑现的结果：应答晚一点到，用来测“请求还在路上的时候又来了别的事”
        if (result instanceof Promise) result.then(reply, fail)
        else reply(result)
      } catch (error) {
        fail(error)
      }
    },
    close() {},
  })
  return {
    seen,
    notify(method, params) {
      transport.send(JSON.stringify(params === undefined ? { method } : { method, params }))
    },
    ask(method, params, given) {
      const id = given ?? `srv-${askId++}`
      return new Promise((resolve) => {
        waiting.set(String(id), resolve)
        transport.send(JSON.stringify({ id, method, params }))
      })
    },
    drop() {
      transport.close()
    },
  }
}

export const INIT = {
  userAgent: 'fake/1.0.0',
  codexHome: '/home/dev/.fake',
  platformFamily: 'unix',
  platformOs: 'macos',
}

/**
 * 一个每次调用都新开一对传输的“开传输”函数，对面挂上假对端。
 * failures 里排着的错误会先被依次抛出，用来测重连。
 */
export function fakeOpener(handlers: Record<string, Handler>) {
  const servers: FakeServer[] = []
  const failures: Error[] = []
  const open: TransportOpener = async () => {
    const failure = failures.shift()
    if (failure) throw failure
    const [client, server] = createTransportPair()
    servers.push(serveFake(server, { initialize: () => INIT, ...handlers }))
    return client
  }
  return {
    open,
    servers,
    failures,
    /** 最近一次连上的那个假对端 */
    last(): FakeServer {
      const server = servers[servers.length - 1]
      if (!server) throw new Error('还没有连接')
      return server
    },
  }
}
