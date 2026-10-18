import { randomUUID } from 'node:crypto'
import type { JsonRpcRequest, JsonRpcResponse, RpcPeer } from './types.mjs'

// Pi 和 dsh 两个引擎发给客户端并等回答的请求（审批、提问、客户端执行的工具调用）。
//
// 一个会话可以同时被几条连接订阅。与开源 codex 的 app-server 一致（outgoing_message.rs）：
// 一条请求用同一个请求号发给该收到它的每条连接，先到的应答生效，随后会话的订阅连接都收到
// serverRequest/resolved；别的连接迟到的应答找不到这条请求，直接丢弃，不产生任何效果。
// 后来才订阅的连接补收到还在等的请求（thread_lifecycle.rs 恢复会话时的重放），请求号不变。
//
// 这两个引擎原有的规矩不变：没有连接可送的请求不受理；拿着请求的连接一条都不剩了，请求按失败结束。

type Notify = (threadId: string, method: string, params: any) => void

interface PendingRequest {
  threadId: string
  message: JsonRpcRequest
  // 请求现在在哪些连接手里，按送达的先后。
  holders: Map<string, RpcPeer>
  // 能不能补送给后来订阅的连接。客户端执行的工具调用送出去就可能已经有了副作用，不补送。
  replayable: boolean
  // 送给某条连接时换用的参数，见 ServerRequestOptions.paramsFor。
  paramsFor: ((peer: RpcPeer) => unknown) | undefined
  resolve: (value: any) => void
  reject: (error: Error) => void
  // 摘掉取消信号上的监听
  clear: () => void
}

export interface ServerRequestOptions {
  signal?: AbortSignal | undefined
  replayable: boolean
  // 请求里有按连接握手时的声明才给的扩展内容时用：送给某条连接之前问一遍，
  // 返回的就是这条连接收到的参数，返回 undefined 的收到 params 那一份。请求号和方法每条连接都一样。
  // 不给这一项时每条连接收到的是同一份，和加它之前逐字节相同。
  paramsFor?: ((peer: RpcPeer) => unknown) | undefined
}

export class ServerRequests {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly notify: Notify

  // notify：给会话的订阅连接发通知，用来说“这条请求已经有结果了”。
  constructor(notify: Notify) {
    this.notify = notify
  }

  /**
   * 发出一条请求并等回答。targets 是此刻该收到它的连接；params 拿到请求号后给出参数，
   * 每条连接收到的是同一份（options.paramsFor 另给的除外）。signal 中止时撤回。
   */
  send(
    targets: RpcPeer[],
    threadId: string,
    method: string,
    params: (id: string) => unknown,
    options: ServerRequestOptions,
  ): Promise<any> {
    const { signal } = options
    if (signal?.aborted) return Promise.reject(new Error('已取消'))
    if (targets.length === 0) return Promise.reject(new Error('没有可处理交互的已连接客户端'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.pending.delete(id)
        signal?.removeEventListener('abort', cancel)
        this.resolved(threadId, id)
        reject(new Error('已取消'))
      }
      const entry: PendingRequest = {
        threadId,
        message: { jsonrpc: '2.0', id, method, params: params(id) },
        holders: new Map(),
        replayable: options.replayable,
        paramsFor: options.paramsFor,
        resolve,
        reject,
        clear: () => signal?.removeEventListener('abort', cancel),
      }
      this.pending.set(id, entry)
      signal?.addEventListener('abort', cancel, { once: true })
      this.deliver(id, entry, targets)
    })
  }

  /** 客户端发来的应答。只认拿着这条请求的连接，先到的生效；其余的丢弃。 */
  answer(peer: RpcPeer, message: JsonRpcResponse): void {
    const id = String(message.id)
    const entry = this.pending.get(id)
    if (!entry?.holders.has(peer.id)) return
    this.pending.delete(id)
    entry.clear()
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
    this.resolved(entry.threadId, message.id)
  }

  /** 订阅关系可能变了之后调用：还在等的请求补送给订阅着会话、却还没拿到它的连接。 */
  replay(subscribers: (threadId: string) => RpcPeer[]): void {
    for (const [id, entry] of [...this.pending])
      if (entry.replayable) this.deliver(id, entry, subscribers(entry.threadId))
  }

  /** 连接断开：它不再拿着任何请求；一条连接都不剩的请求按 reason 结束。别的连接还拿着的继续等。 */
  dropPeer(peerId: string, reason: string): void {
    for (const [id, entry] of [...this.pending])
      if (entry.holders.delete(peerId) && entry.holders.size === 0) this.fail(id, entry, reason)
  }

  /** 作废选中的会话上还在等的请求（回合停止、适配器关闭）。 */
  reject(match: (threadId: string) => boolean, reason: string): void {
    for (const [id, entry] of [...this.pending])
      if (match(entry.threadId)) this.fail(id, entry, reason)
  }

  private deliver(id: string, entry: PendingRequest, peers: RpcPeer[]): void {
    for (const peer of peers) {
      // 前一条连接收到就答了（进程内的连接会这样）：请求已经结束，不再往后发。
      if (this.pending.get(id) !== entry) return
      if (entry.holders.has(peer.id)) continue
      entry.holders.set(peer.id, peer)
      const params = entry.paramsFor?.(peer)
      peer.send(params === undefined ? entry.message : { ...entry.message, params })
    }
  }

  private fail(id: string, entry: PendingRequest, reason: string): void {
    entry.clear()
    entry.reject(new Error(reason))
    this.pending.delete(id)
    this.resolved(entry.threadId, id)
  }

  private resolved(threadId: string, requestId: unknown): void {
    this.notify(threadId, 'serverRequest/resolved', { requestId })
  }
}
