import { ProtocolError } from './protocol-contract.mjs'
import type { JsonRpcResponse, RpcPeer } from './types.mjs'

interface PendingInteraction {
  id: string
  method: string
  params: unknown
  // 发给某条连接时实际用的参数；没给就都用 params。见 InteractionOptions.paramsFor。
  paramsFor: ((peer: RpcPeer) => unknown) | undefined
  threadId: string
  // 请求现在在哪些连接手里，按送达的先后；空表示没有客户端在看，先留着，等有连接订阅这个线程再送。
  holders: Map<string, RpcPeer>
  // 这个线程此刻该由哪些连接来答；没有客户端在看时返回空。
  targets: () => RpcPeer[]
  finish(response?: JsonRpcResponse, error?: Error): void
}

export interface InteractionOptions {
  signal?: AbortSignal
  // 请求结束（回答、取消、失效）时调用，参数是当时拿着这条请求的连接；没送出去过就是空的。
  onFinished?: (holders: RpcPeer[]) => void
  // 按要送去的连接给参数。协议扩展的内容只发给握手时声明过的连接，同一条请求送给几条连接、
  // 或者之后补送给别的连接时，每条各按自己的声明给一份：声明过的带扩展内容，没声明的是标准形状。
  paramsFor?: (peer: RpcPeer) => unknown
}

// 一条请求送出去之后，还能不能再送给别的连接（后来订阅的、或者原来那条不在了之后接手的）。
// 客户端执行的工具调用一旦送出就可能已经产生副作用，只在一条连接手里，不能再送；不属于任何线程的请求
// （握手后探测 MCP 服务时的征询）只跟发起它的连接走，没有别的连接可以接手。
// 其余请求（审批、提问、回合里的 MCP 征询）只是要一个决定，可以原样再送一次。
function replayable(entry: { method: string; threadId: string }): boolean {
  return entry.threadId !== '' && entry.method !== 'item/tool/call'
}

// 发给客户端并等回答的请求。它们跟着线程的订阅连接走：没有客户端在看时一直留着，
// 有连接订阅了就送过去。
//
// 一个线程可以同时被几条连接订阅。与开源 codex 的 app-server 一致（outgoing_message.rs）：
// 纯决定类的请求用同一个请求 ID 发给全部订阅连接，先到的回答生效，其余连接随后被告知
// 这条请求已经有结果，它们迟到的回答找不到这条请求，直接丢弃。后来才订阅的连接补收到
// 还在等的请求，与原生“恢复线程时重放挂起的服务端请求”一致。
// 订阅连接断开只摘掉它自己；一条都不剩了，请求回到没人可送，照旧留着。
export class PendingInteractions {
  private pending = new Map<string, PendingInteraction>()
  // 请求从一条仍然连着的连接手里收回时调用，让它撤掉界面上的卡片。
  private readonly withdrawn: (peer: RpcPeer, threadId: string, id: string) => void

  constructor(withdrawn: (peer: RpcPeer, threadId: string, id: string) => void = () => {}) {
    this.withdrawn = withdrawn
  }

  request(
    targets: () => RpcPeer[],
    method: string,
    id: string,
    params: unknown,
    options: InteractionOptions = {},
  ): Promise<unknown> {
    const { signal, onFinished, paramsFor } = options
    if (signal?.aborted) return Promise.reject(new ProtocolError(-32010, '交互请求已取消'))
    if (this.pending.has(id)) throw new ProtocolError(-32009, '交互请求 ID 冲突')
    const threadId = String((params as Record<string, unknown>).threadId ?? '')
    return new Promise((resolve, reject) => {
      const finish = (response?: JsonRpcResponse, error?: Error) => {
        const entry = this.pending.get(id)
        if (!entry || !this.pending.delete(id)) return
        signal?.removeEventListener('abort', cancelled)
        // 在唤醒等待者前发送结束事件，崩溃和取消也使用同一个完成路径。
        try {
          onFinished?.([...entry.holders.values()])
        } catch (notificationError) {
          error ??=
            notificationError instanceof Error
              ? notificationError
              : new Error(String(notificationError))
        }
        if (error) reject(error)
        else if (response?.error)
          reject(new ProtocolError(response.error.code, response.error.message))
        else resolve(response?.result)
      }
      const cancelled = () => finish(undefined, new ProtocolError(-32010, '交互请求已取消'))
      // 人工交互持续等待，直到回答、取消或运行时停止；没有客户端在看也一直等。
      const entry: PendingInteraction = {
        id,
        method,
        params,
        paramsFor,
        threadId,
        holders: new Map(),
        targets,
        finish,
      }
      this.pending.set(id, entry)
      signal?.addEventListener('abort', cancelled, { once: true })
      const first = targets()
      // 没有线程可订阅的请求等不来别的连接：发起它的连接不在就直接失败。
      if (first.length === 0 && !threadId)
        finish(undefined, new ProtocolError(-32010, '交互连接已关闭，结果未确认'))
      else this.deliver(entry, first)
    })
  }

  // 只认拿着这条请求的连接；先到的生效，请求随之结束，别的连接之后的回答找不到它。
  resolve(peer: RpcPeer, response: JsonRpcResponse): void {
    const entry = this.pending.get(String(response.id))
    if (entry?.holders.has(peer.id)) entry.finish(response)
  }

  // 订阅关系变了之后调用：请求补送给现在在看这个线程、却还没拿到它的连接；
  // 不再该答它的连接（退订了但还连着）把它收回。
  reroute(): void {
    for (const entry of [...this.pending.values()]) {
      // 已经送出的工具调用不换连接、不补送；它所在的连接断开时按失败结束。
      if (entry.holders.size > 0 && !replayable(entry)) continue
      const next = entry.targets()
      for (const holder of [...entry.holders.values()]) {
        if (next.some((peer) => peer.id === holder.id)) continue
        entry.holders.delete(holder.id)
        this.withdrawn(holder, entry.threadId, entry.id)
      }
      this.deliver(entry, next)
    }
  }

  // 连接断开：只摘掉它自己。决定类请求别的连接还拿着就继续等，一条都不剩就回到“没人可送”，
  // 等下一个订阅者；不能再送的按失败结束。
  dropPeer(peerId: string): void {
    for (const entry of [...this.pending.values()]) {
      if (!entry.holders.has(peerId)) continue
      if (replayable(entry)) entry.holders.delete(peerId)
      else entry.finish(undefined, new ProtocolError(-32010, '交互连接已关闭，结果未确认'))
    }
  }

  // 连接断开且之后不会再有别的连接（标准输入输出上的连接就是进程的寿命）：它手里的请求全部失效。
  cancelPeer(peerId: string): void {
    this.cancel((entry) => entry.holders.has(peerId), '交互连接已关闭，结果未确认')
  }

  cancelThread(threadId: string): void {
    this.cancel((entry) => entry.threadId === threadId, 'Turn 已中断，交互请求失效')
  }

  close(): void {
    this.cancel(() => true, '运行时停止，交互请求失效')
  }

  // 这个线程有没有还在等回答的请求。
  has(threadId: string): boolean {
    for (const entry of this.pending.values()) if (entry.threadId === threadId) return true
    return false
  }

  // 有请求在等、却没有连接可送的线程。
  unattended(): string[] {
    const threads = new Set<string>()
    for (const entry of this.pending.values())
      if (entry.holders.size === 0) threads.add(entry.threadId)
    return [...threads]
  }

  // 送给 peers 里还没拿到这条请求的连接。
  private deliver(entry: PendingInteraction, peers: RpcPeer[]): void {
    for (const peer of peers) {
      // 前一条连接收到就答了（进程内的连接会这样）：请求已经结束，不再往后发。
      if (this.pending.get(entry.id) !== entry) return
      if (entry.holders.has(peer.id)) continue
      entry.holders.set(peer.id, peer)
      try {
        const params = entry.paramsFor ? entry.paramsFor(peer) : entry.params
        peer.send({ jsonrpc: '2.0', id: entry.id, method: entry.method, params })
      } catch (error) {
        entry.finish(undefined, error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  private cancel(predicate: (entry: PendingInteraction) => boolean, message: string): void {
    for (const entry of [...this.pending.values()])
      if (predicate(entry)) entry.finish(undefined, new ProtocolError(-32010, message))
  }
}
