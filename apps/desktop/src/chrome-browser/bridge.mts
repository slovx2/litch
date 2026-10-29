import { randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import {
  CHROME_WIRE_VERSION,
  type ChromeErrorCode,
  type ChromeEvent,
  type ChromeInstance,
  type ChromeReply,
  type ChromeRequest,
} from '../../../../packages/protocol/src/chrome-browser.mjs'

export class ChromeBridgeError extends Error {
  readonly code: ChromeErrorCode
  constructor(code: ChromeErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

interface Peer {
  socket: Socket
  instance: ChromeInstance
}
interface Pending {
  peer: Peer
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  off(): void
}
export interface BridgeOptions {
  socketPath: string
  token: string
  extensionId: string
  version: string
}

export class ChromeBridge {
  private server: Server | null = null
  private peers = new Map<string, Peer>()
  private sockets = new Set<Socket>()
  private pending = new Map<string, Pending>()
  private listeners = new Set<
    (instanceId: string, event: ChromeEvent | { kind: 'disconnected' }) => void
  >()
  private options: BridgeOptions
  constructor(options: BridgeOptions) {
    this.options = options
  }

  instances(): ChromeInstance[] {
    return [...this.peers.values()].map((peer) => ({ ...peer.instance }))
  }
  onEvent(
    listener: (instanceId: string, event: ChromeEvent | { kind: 'disconnected' }) => void,
  ): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private emit(id: string, event: ChromeEvent | { kind: 'disconnected' }): void {
    for (const listener of this.listeners) listener(id, event)
  }

  async start(): Promise<void> {
    await mkdir(dirname(this.options.socketPath), { recursive: true, mode: 0o700 })
    // socketPath 属于本次桌面实例，安装配置始终指向这一份；不删除别的服务路径。
    const server = createServer((socket) => this.accept(socket))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.socketPath, resolve)
    })
    await chmod(this.options.socketPath, 0o600)
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    let authenticated = false
    let peer: Peer | null = null
    const timeout = setTimeout(() => socket.destroy(), 5000)
    socket.on('data', (part: string) => {
      buffer += part
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
        socket.destroy()
        return
      }
      for (;;) {
        const end = buffer.indexOf('\n')
        if (end < 0) break
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        try {
          const message = JSON.parse(line)
          if (!authenticated) {
            const actual = Buffer.from(typeof message.token === 'string' ? message.token : '')
            const expected = Buffer.from(this.options.token)
            if (
              message.kind !== 'nativeHello' ||
              message.origin !== `chrome-extension://${this.options.extensionId}/` ||
              actual.length !== expected.length ||
              !timingSafeEqual(actual, expected)
            ) {
              socket.destroy()
              return
            }
            authenticated = true
            continue
          }
          if (!peer) {
            if (
              message.kind !== 'hello' ||
              !/^[a-zA-Z0-9-]{1,128}$/.test(message.instanceId) ||
              typeof message.epoch !== 'string' ||
              message.epoch.length > 128 ||
              typeof message.version !== 'string'
            ) {
              socket.destroy()
              return
            }
            clearTimeout(timeout)
            const previous = this.peers.get(message.instanceId)
            previous?.socket.destroy()
            peer = {
              socket,
              instance: {
                id: message.instanceId,
                epoch: message.epoch,
                version: message.version,
                name: 'Chrome',
                compatible:
                  message.protocol === CHROME_WIRE_VERSION &&
                  message.version === this.options.version,
              },
            }
            this.peers.set(peer.instance.id, peer)
            this.emit(peer.instance.id, message as ChromeEvent)
          } else if (message.kind === 'result') this.resolve(peer, message)
          else if (['tab', 'revoked', 'removed', 'dialog'].includes(message.kind))
            this.emit(peer.instance.id, message)
        } catch {
          socket.destroy()
          return
        }
      }
    })
    socket.on('error', () => {})
    socket.once('close', () => {
      clearTimeout(timeout)
      this.sockets.delete(socket)
      if (!peer) return
      if (this.peers.get(peer.instance.id) === peer) {
        this.peers.delete(peer.instance.id)
        this.emit(peer.instance.id, { kind: 'disconnected' })
      }
      for (const [id, call] of this.pending)
        if (call.peer === peer)
          this.finish(
            id,
            new ChromeBridgeError(
              'disconnected',
              'Chrome disconnected; an action may have executed. Do not retry blindly. List targets and claim again.',
            ),
          )
    })
  }

  async call<T = unknown>(
    instanceId: string,
    request: Omit<ChromeRequest, 'kind' | 'id' | 'epoch'>,
    signal?: AbortSignal,
  ): Promise<T> {
    const peer = this.peers.get(instanceId)
    if (!peer)
      throw new ChromeBridgeError(
        'disconnected',
        'Chrome is not connected. Open the Litch Chrome extension and retry.',
      )
    if (!peer.instance.compatible)
      throw new ChromeBridgeError(
        'versionMismatch',
        'Reload the Litch extension from chrome://extensions to match this Litch version.',
      )
    if (signal?.aborted) throw new ChromeBridgeError('cancelled', 'The call was cancelled.')
    const id = randomUUID()
    const data = `${JSON.stringify({ ...request, kind: 'request', id, epoch: peer.instance.epoch })}\n`
    if (Buffer.byteLength(data) > 512 * 1024)
      throw new ChromeBridgeError('invalid', 'Chrome request exceeds 512 KiB.')
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        this.finish(
          id,
          new ChromeBridgeError(
            'cancelled',
            'The call was cancelled; an input already sent may have executed.',
          ),
        )
        if (request.leaseId)
          void this.call(instanceId, { op: 'release', leaseId: request.leaseId, args: {} }).catch(
            () => {},
          )
      }
      const timer = setTimeout(
        () =>
          this.finish(
            id,
            new ChromeBridgeError(
              'failed',
              'Chrome timed out; an action may have executed. Do not retry blindly.',
            ),
          ),
        30_000,
      )
      this.pending.set(id, {
        peer,
        timer,
        off: () => signal?.removeEventListener('abort', cancel),
        resolve: (value) => resolve(value as T),
        reject,
      })
      signal?.addEventListener('abort', cancel, { once: true })
      peer.socket.write(data)
    })
  }

  private resolve(peer: Peer, reply: ChromeReply): void {
    const call = this.pending.get(reply.id)
    if (!call || call.peer !== peer) return
    this.finish(
      reply.id,
      reply.error ? new ChromeBridgeError(reply.error.code, reply.error.message) : null,
      reply.result,
    )
  }
  private finish(id: string, error: Error | null, result?: unknown): void {
    const call = this.pending.get(id)
    if (!call) return
    this.pending.delete(id)
    clearTimeout(call.timer)
    call.off()
    if (error) call.reject(error)
    else call.resolve(result)
  }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(this.options.socketPath, { force: true })
  }
}
