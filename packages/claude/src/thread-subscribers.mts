import type { RpcPeer } from './types.mjs'

// 会话的订阅连接。
//
// 一个会话可以同时被几条连接订阅（两个客户端，或同一个客户端的两个窗口同看一个会话）：
// 会话的通知发给全部订阅连接，等人回答的请求也是（见 PendingInteractions）。
// 与开源 codex 的 app-server 一致（thread_state.rs）：订阅是“连接的集合”，
// 恢复、新建、分叉、发消息把发起请求的连接加进集合；退订和断开只摘掉它自己。
//
// 集合按订阅的先后排列。需要“代表这个会话的一条连接”的地方（没有发起人的回合、
// 目标续跑、队列出队）用最早订阅的那条；只有一条连接时它就是那一条。
export class ThreadSubscribers {
  // 会话标识 → 连接标识 → 连接。一条订阅连接都没有的会话不留在表里。
  private readonly byThread = new Map<string, Map<string, RpcPeer>>()

  add(threadId: string, peer: RpcPeer): void {
    const peers = this.byThread.get(threadId) ?? new Map<string, RpcPeer>()
    peers.set(peer.id, peer)
    this.byThread.set(threadId, peers)
  }

  /** 退订：只摘掉这一条。返回它原来是不是订阅着。 */
  remove(threadId: string, peer: RpcPeer): boolean {
    const peers = this.byThread.get(threadId)
    if (!peers?.delete(peer.id)) return false
    if (peers.size === 0) this.byThread.delete(threadId)
    return true
  }

  /** 连接断开：从它订阅的全部会话里摘掉。 */
  removePeer(peer: RpcPeer): void {
    for (const threadId of this.threadsOf(peer)) this.remove(threadId, peer)
  }

  /** 会话没了（删除）：清空，返回原来的订阅连接。 */
  clear(threadId: string): RpcPeer[] {
    const peers = this.list(threadId)
    this.byThread.delete(threadId)
    return peers
  }

  list(threadId: string): RpcPeer[] {
    return [...(this.byThread.get(threadId)?.values() ?? [])]
  }

  first(threadId: string): RpcPeer | undefined {
    return this.list(threadId)[0]
  }

  has(threadId: string): boolean {
    return this.byThread.has(threadId)
  }

  /** 有连接订阅着的会话，按“从无人订阅变成有人订阅”的先后。 */
  threads(): string[] {
    return [...this.byThread.keys()]
  }

  /** 这条连接订阅着的会话，顺序同上。 */
  threadsOf(peer: RpcPeer): string[] {
    return this.threads().filter((threadId) => this.byThread.get(threadId)?.has(peer.id))
  }
}
