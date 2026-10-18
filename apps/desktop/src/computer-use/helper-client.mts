// 连到助手的一条连接：握手、请求与应答、助手发来的通知。断了就作废，由 supervisor 决定要不要重连。
// 底下是任意一条双工的字节流（HelperChannel）：macOS 是 unix 套接字，Windows 是助手子进程的标准输入输出。帧两边一样。
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import {
  encodeFrame,
  FrameReader,
  HELPER_PROTOCOL,
  type HelloResult,
  HelperError,
  type HelperErrorKind,
  type HelperHello,
  type HelperStopped,
} from './wire.mjs'

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  cleanup(): void
}

export interface HelperClientEvents {
  /** 用户在屏幕提示上按了停止 */
  onStopped?(notice: HelperStopped): void
  /** 连接断了（对面退出、崩溃、被关掉） */
  onClose?(): void
}

/** 连接底下的那条字节流 */
export interface HelperChannel {
  write(data: Buffer): void
  /** 收到字节。只调一次 */
  onData(listener: (data: Buffer) => void): void
  /** 流断了（不管哪一头先断）。只调一次，可能来不止一次 */
  onClose(listener: () => void): void
  /** 主动断开 */
  close(): void
}

/** unix 套接字上的流（macOS） */
export function socketChannel(socket: Socket): HelperChannel {
  socket.on('error', () => {})
  return {
    write: (data) => {
      socket.write(data)
    },
    onData: (listener) => socket.on('data', listener),
    onClose: (listener) => socket.on('close', listener),
    close: () => socket.destroy(),
  }
}

/**
 * 子进程标准输入输出上的流（Windows）。断开时先关它的标准输入（助手读到结尾自己退出），
 * 过 graceMs 还没退出再结束它
 */
export function childChannel(child: ChildProcessWithoutNullStreams, graceMs = 2000): HelperChannel {
  // 对面已经退出时往标准输入写会报 EPIPE；断没断由 close 事件说了算
  child.stdin.on('error', () => {})
  child.stdout.on('error', () => {})
  const exited = () => child.exitCode !== null || child.signalCode !== null
  return {
    write: (data) => {
      if (child.stdin.writable) child.stdin.write(data)
    },
    onData: (listener) => child.stdout.on('data', listener),
    onClose(listener) {
      child.stdout.on('close', listener)
      child.on('exit', listener)
      child.on('error', listener)
    },
    close() {
      child.stdin.end()
      if (exited()) return
      const timer = setTimeout(() => {
        if (!exited()) child.kill()
      }, graceMs)
      timer.unref?.()
      child.once('exit', () => clearTimeout(timer))
    },
  }
}

const KINDS = new Set<HelperErrorKind>([
  'unauthorized',
  'invalid',
  'permission',
  'notFound',
  'forbidden',
  'stopped',
  'userActive',
  'stale',
  'failed',
  'elevated',
  'locked',
  'foreground',
])

export class HelperClient {
  private readonly channel: HelperChannel
  private readonly reader = new FrameReader()
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closed = false
  hello: HelperHello | null = null

  /** 事件的处理，看护的一方接手连接后会换成自己的 */
  events: HelperClientEvents

  constructor(channel: HelperChannel, events: HelperClientEvents = {}) {
    this.channel = channel
    this.events = events
    channel.onData((data: Buffer) => this.receive(data))
    channel.onClose(() => this.shutdown(new HelperError('failed', 'helper connection closed')))
  }

  /** 连上套接字（不握手）。连不上时抛错 */
  static connect(path: string, events: HelperClientEvents = {}): Promise<HelperClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path)
      const fail = (error: Error) => {
        socket.destroy()
        reject(error)
      }
      socket.once('error', fail)
      socket.once('connect', () => {
        socket.off('error', fail)
        resolve(new HelperClient(socketChannel(socket), events))
      })
    })
  }

  get isOpen(): boolean {
    return !this.closed
  }

  /** 握手：协议版本、令牌（macOS 开发期）、语言 */
  async handshake<T extends HelperHello = HelloResult>(
    token: string | null,
    lang: string,
    protocol: number = HELPER_PROTOCOL,
  ): Promise<T> {
    const result = (await this.request(
      'hello',
      { protocol, ...(token ? { token } : {}), lang },
      5000,
    )) as T
    this.hello = result
    return result
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new HelperError('failed', 'helper is not connected'))
    if (signal?.aborted) return Promise.reject(new HelperError('failed', 'cancelled'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.settle(id)?.reject(new HelperError('failed', 'cancelled'))
      }
      const timer = setTimeout(() => {
        this.settle(id)?.reject(
          new HelperError('failed', `helper did not answer ${method} in time`),
        )
      }, timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      })
      this.channel.write(encodeFrame({ jsonrpc: '2.0', id, method, params }))
    })
  }

  close(): void {
    this.channel.close()
  }

  private settle(id: number): Pending | undefined {
    const entry = this.pending.get(id)
    if (!entry) return undefined
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.cleanup()
    return entry
  }

  private receive(data: Buffer): void {
    this.reader.push(data)
    try {
      for (let frame = this.reader.next(); frame !== undefined; frame = this.reader.next()) {
        this.dispatch(frame as Record<string, unknown>)
      }
    } catch (error) {
      this.shutdown(new HelperError('failed', `bad frame from helper: ${(error as Error).message}`))
      this.channel.close()
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    if (typeof message.method === 'string') {
      if (message.method === 'stopped') this.events.onStopped?.(message.params as HelperStopped)
      return
    }
    if (typeof message.id !== 'number') return
    const entry = this.settle(message.id)
    if (!entry) return
    const error = message.error as { message?: string; data?: { kind?: string } } | undefined
    if (error) {
      const kind = KINDS.has(error.data?.kind as HelperErrorKind)
        ? (error.data?.kind as HelperErrorKind)
        : 'failed'
      entry.reject(new HelperError(kind, error.message ?? 'helper error'))
    } else {
      entry.resolve(message.result)
    }
  }

  private shutdown(error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(error)
    this.events.onClose?.()
  }
}
