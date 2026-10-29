import type { RpcPeer, WireMessage } from './types.mjs'

export interface PowerThread {
  threadId: string
  active: boolean
  background: boolean
}

/** 设备进程的只读内存观察连接，不参与普通客户端的订阅、声明或离线清理。 */
export class PowerObserver {
  private readonly peers = new WeakSet<RpcPeer>()
  private readonly ordinary = new WeakSet<RpcPeer>()

  handle(
    peer: RpcPeer,
    message: WireMessage,
    snapshot: (threadIds?: string[]) => PowerThread[],
  ): boolean {
    const method = 'method' in message ? message.method : null
    const p = 'params' in message ? (message.params as any) : null
    const greeting = method === 'initialize' && p?.clientInfo?.name === 'litch-power-observer'
    if (!greeting && !this.peers.has(peer) && method !== 'litch/internal/power/activity') {
      if (method === 'initialize') this.ordinary.add(peer)
      return false
    }
    if (!('id' in message)) return true
    const reply = (result: unknown) => peer.send({ jsonrpc: '2.0', id: message.id, result })
    const fail = (code: number, text: string) =>
      peer.send({ jsonrpc: '2.0', id: message.id, error: { code, message: text } })
    if (greeting) {
      if (this.ordinary.has(peer)) {
        fail(-32600, '电源观察必须使用独立连接')
        return true
      }
      this.peers.add(peer)
      reply({ userAgent: 'litch-power-observer', codexHome: '', platformFamily: process.platform })
    } else if (this.peers.has(peer) && method === 'litch/internal/power/activity') {
      const ids = p?.threadIds
      if (
        ids !== undefined &&
        (!Array.isArray(ids) ||
          ids.length > 16384 ||
          ids.some((id) => typeof id !== 'string' || !id))
      )
        fail(-32602, 'threadIds must be an array of strings')
      else reply({ threads: snapshot(ids) })
    } else fail(-32601, `method not implemented: ${method}`)
    return true
  }

  close(peer: RpcPeer): boolean {
    return this.peers.delete(peer)
  }
}

/** 候选集合只在恢复时枚举；周期查询严格按给定线程读取内存。 */
export function powerThreads(
  ids: string[] | undefined,
  candidates: () => Iterable<string>,
  read: (id: string) => Omit<PowerThread, 'threadId'>,
): PowerThread[] {
  const rows = [...new Set(ids ?? candidates())].map((threadId) => ({
    threadId,
    ...read(threadId),
  }))
  return ids === undefined ? rows.filter((row) => row.active || row.background) : rows
}
