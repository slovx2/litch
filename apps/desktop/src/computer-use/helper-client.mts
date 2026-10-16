// 连到助手的一条连接：握手、请求与应答、助手发来的通知。断了就作废，由 supervisor 决定要不要重连。
import { createConnection, type Socket } from 'node:net'
import {
  encodeFrame,
  FrameReader,
  HELPER_PROTOCOL,
  type HelloResult,
  HelperError,
  type HelperErrorKind,
  type StoppedNotice,
} from './wire.mjs'

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  cleanup(): void
}

export interface HelperClientEvents {
  /** 用户在屏幕提示上按了停止 */
  onStopped?(notice: StoppedNotice): void
  /** 连接断了（对面退出、崩溃、被关掉） */
  onClose?(): void
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
])

export class HelperClient {
  private readonly socket: Socket
  private readonly reader = new FrameReader()
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closed = false
  hello: HelloResult | null = null

  /** 事件的处理，看护的一方接手连接后会换成自己的 */
  events: HelperClientEvents

  private constructor(socket: Socket, events: HelperClientEvents) {
    this.socket = socket
    this.events = events
    socket.on('data', (data: Buffer) => this.receive(data))
    socket.on('close', () => this.shutdown(new HelperError('failed', 'helper connection closed')))
    socket.on('error', () => {})
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
        resolve(new HelperClient(socket, events))
      })
    })
  }

  get isOpen(): boolean {
    return !this.closed
  }

  /** 握手：版本、令牌（开发期）、语言 */
  async handshake(token: string | null, lang: string): Promise<HelloResult> {
    const result = (await this.request(
      'hello',
      { protocol: HELPER_PROTOCOL, ...(token ? { token } : {}), lang },
      5000,
    )) as HelloResult
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
      this.socket.write(encodeFrame({ jsonrpc: '2.0', id, method, params }))
    })
  }

  close(): void {
    this.socket.destroy()
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
      this.socket.destroy()
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    if (typeof message.method === 'string') {
      if (message.method === 'stopped') this.events.onStopped?.(message.params as StoppedNotice)
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
