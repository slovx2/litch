// 两种传输共用的那一半：把一条已经握完手的 WebSocket 包成核心要的传输接口。
// 本机套接字和 ssh 的标准输入输出上跑的是同一种格式（一帧一条 JSON），所以这里只有一份。
import { phrase, type Text, type Transport, type TransportHandlers } from '@litch/core'
import { WebSocket } from 'ws'

/** 一个很长的会话读回来可以有几十兆 */
export const MAX_PAYLOAD = 512 * 1024 * 1024

export interface WrapOptions {
  /**
   * 心跳：隔这么久发一个 ping，对面在 timeoutMs 之内什么都没发回来就当它死了，主动断开。
   * ssh 假死很常见，光等 ssh 自己发现要好几分钟。本机套接字不用。
   */
  heartbeat?: { everyMs: number; timeoutMs: number }
  /** 不是自己关的时候，问一句断开的原因（ssh 退出时留下的报错比 WebSocket 的关闭码有用） */
  reason?(): Text | null
  /** 传输结束了，不管是谁关的。只调一次 */
  ended?(): void
  /**
   * 承载这条 WebSocket 的东西自己没了（ssh 进程退了）。调用方在那时调 report，这边就按断开收场，
   * 不等 WebSocket 自己发现：它是从流的结束、关闭事件上知道的，那一串事件不保证走得完
   */
  lost?(report: () => void): void
}

export function wrapSocket(socket: WebSocket, options: WrapOptions = {}): Transport {
  let handlers: TransportHandlers | null = null
  let closed = false
  // 打开之后、有人来听之前到达的帧先留着
  const backlog: string[] = []
  let closedWith: { reason: Text | null } | null = null
  let beat: NodeJS.Timeout | null = null
  let deadline: NodeJS.Timeout | null = null
  /** 上一拍心跳时这条 WebSocket 已经在“正在关闭”上了 */
  let stalled = false

  const finish = (reason: Text | null) => {
    if (closed) return
    closed = true
    if (beat) clearInterval(beat)
    if (deadline) clearTimeout(deadline)
    options.ended?.()
    if (handlers) handlers.close(reason)
    else closedWith = { reason }
  }

  /** 对面有动静：不管是应答心跳还是发来一帧，都说明它还活着 */
  const alive = () => {
    if (deadline) clearTimeout(deadline)
    deadline = null
  }

  if (options.heartbeat) {
    const { everyMs, timeoutMs } = options.heartbeat
    beat = setInterval(() => {
      // 上一拍就在关了，到这一拍还没关完：不会再有动静了，按断开收场
      if (socket.readyState === WebSocket.CLOSING && stalled) {
        finish(options.reason?.() ?? phrase('connect.dropped'))
        socket.terminate()
        return
      }
      stalled = socket.readyState === WebSocket.CLOSING
      if (socket.readyState !== WebSocket.OPEN || deadline) return
      socket.ping()
      deadline = setTimeout(() => {
        finish(phrase('connect.heartbeat'))
        socket.terminate()
      }, timeoutMs)
    }, everyMs)
    socket.on('pong', alive)
  }

  socket.on('message', (data, isBinary) => {
    alive()
    if (isBinary) return
    const text = data.toString()
    if (handlers) handlers.message(text)
    else backlog.push(text)
  })
  socket.on('close', (code, reason) => {
    if (code === 1000) return finish(null)
    finish(options.reason?.() ?? (reason.toString() || phrase('connect.closed', { code })))
  })
  socket.on('error', (error) => finish(options.reason?.() ?? error.message))
  options.lost?.(() => {
    if (closed) return
    finish(options.reason?.() ?? phrase('connect.dropped'))
    socket.terminate()
  })

  return {
    send(text) {
      if (socket.readyState === WebSocket.OPEN) socket.send(text)
    },
    listen(next) {
      handlers = next
      for (const text of backlog.splice(0)) next.message(text)
      if (closedWith) next.close(closedWith.reason)
    },
    close() {
      socket.close(1000)
      // 对面不回关闭帧的话不能一直挂着
      setTimeout(() => {
        socket.terminate()
        finish(null)
      }, 1000).unref()
    },
  }
}
