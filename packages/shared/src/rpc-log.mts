// 入口的协议请求摘要（<日志目录>/rpc.jsonl）：每个请求的方法、连接、编号、成败、耗时、错误原文，
// 服务端发出的请求和对面的答复，连接的开和关。通知不记，参数只挑标识和设置字段（log-file.mts 的 paramFields）。
// 传输层（transports.mts）收发每一帧时调这里；命令行没给日志目录（测试、单独跑）时什么都不做。
import { basename, join } from 'node:path'
import { createJsonlLog, errorText, type JsonlLog, paramFields, takeLogDir } from './log-file.mjs'
import type { RpcPeer, WireMessage } from './types.mjs'

interface Pending {
  method: string
  at: number
  ids: Record<string, unknown>
}

export interface RpcTrace {
  opened(peer: RpcPeer): void
  closed(peer: RpcPeer): void
  received(peer: RpcPeer, message: WireMessage): void
  sent(peer: RpcPeer, message: WireMessage): void
}

const peerTag = (peer: RpcPeer) => peer.id.slice(0, 8)
const keyOf = (peer: RpcPeer, id: unknown) => `${peer.id}\u0000${typeof id}:${String(id)}`

export function createRpcTrace(log: JsonlLog, now: () => number = Date.now): RpcTrace {
  /** 对面发来、还没应答的请求 */
  const incoming = new Map<string, Pending>()
  /** 这一头发出去、还没等到答复的请求 */
  const outgoing = new Map<string, Pending>()
  const settle = (
    map: Map<string, Pending>,
    event: string,
    peer: RpcPeer,
    message: WireMessage,
  ) => {
    const key = keyOf(peer, (message as { id?: unknown }).id)
    const entry = map.get(key)
    if (!entry) return
    map.delete(key)
    const error = (message as { error?: unknown }).error
    log.write(
      event,
      {
        method: entry.method,
        peer: peerTag(peer),
        id: (message as { id?: unknown }).id,
        ...entry.ids,
        ok: error === undefined,
        ms: now() - entry.at,
        ...(error === undefined ? {} : { error: errorText(error) }),
      },
      error === undefined ? 'info' : 'warn',
    )
  }
  const forget = (map: Map<string, Pending>, peer: RpcPeer): number => {
    let count = 0
    for (const key of map.keys()) {
      if (key.startsWith(`${peer.id}\u0000`)) {
        map.delete(key)
        count += 1
      }
    }
    return count
  }
  return {
    opened(peer) {
      log.write('peer.open', { peer: peerTag(peer) })
    },
    closed(peer) {
      const unanswered = forget(incoming, peer)
      const waiting = forget(outgoing, peer)
      log.write('peer.close', {
        peer: peerTag(peer),
        ...(unanswered ? { unanswered } : {}),
        ...(waiting ? { waiting } : {}),
      })
    },
    received(peer, message) {
      const id = (message as { id?: unknown }).id
      if (id === undefined || id === null) return
      const method = (message as { method?: unknown }).method
      if (typeof method === 'string') {
        incoming.set(keyOf(peer, id), {
          method,
          at: now(),
          ids: paramFields((message as { params?: unknown }).params),
        })
      } else settle(outgoing, 'serverRequest', peer, message)
    },
    sent(peer, message) {
      const id = (message as { id?: unknown }).id
      if (id === undefined || id === null) return
      const method = (message as { method?: unknown }).method
      if (typeof method === 'string') {
        outgoing.set(keyOf(peer, id), {
          method,
          at: now(),
          ids: paramFields((message as { params?: unknown }).params),
        })
      } else settle(incoming, 'rpc', peer, message)
    },
  }
}

let trace: RpcTrace | null | undefined

/**
 * 这个进程的协议请求摘要。头一次调用时取命令行给的日志目录（并从环境里拿掉）；没给就是 null。
 * 来源名用日志目录的名字：命令行给每个入口的是 logs/<harness>
 */
export function rpcTrace(): RpcTrace | null {
  if (trace !== undefined) return trace
  const directory = takeLogDir()
  trace = directory
    ? createRpcTrace(createJsonlLog(join(directory, 'rpc.jsonl'), { source: basename(directory) }))
    : null
  return trace
}

// 模块一加载就取走日志目录：入口起任何子进程之前，变量就已经不在环境里了
rpcTrace()
