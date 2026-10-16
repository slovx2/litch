// 到一个运行时的一条上游连接。一条客户端连接对应一组这样的连接，各自握手（设计文档 03 第 3.1 节）。
// 设备进程对运行时来说只是又一个客户端：运行时把订阅、待答的请求这些状态记在连接名下，
// 一对一之后这些语义原样成立，客户端断开时这条连接跟着断，运行时自己会清理。
import type { HarnessUnavailable, HarnessUnavailableKind } from '../../protocol/src/device.mjs'
import type { UpstreamDialect } from './dialect.mjs'
import {
  type Connector,
  type Frame,
  idKey,
  isObject,
  type RpcId,
  UpstreamRpcError,
  type Wire,
} from './wire.mjs'

/** 设备进程自己向上游发的请求用的请求号前缀。客户端的请求号不许用它，免得应答分不清是谁的 */
export const INTERNAL_ID_PREFIX = 'litch-device:'

/** 握手时从上游得到的信息 */
export interface UpstreamFacts {
  userAgent: string | null
  /**
   * 上游的声明，形状是 `runtime/info` 的应答。适配器的运行时是它自己报的，原生 codex 的由设备进程替它整理
   * （native-codex.mts）。拿不到（旧版的适配器不认识这个方法）时是 null
   */
  runtime: Record<string, unknown> | null
}

export interface ForwardedRequest {
  id: RpcId
  method: string
}

export interface LinkOptions {
  harness: string
  connect: Connector
  /** 对面说哪种话：适配器的运行时，还是原生的 codex（dialect.mts） */
  dialect: UpstreamDialect
  /**
   * 客户端握手时给聚合面的参数：它自己的 clientInfo 和 capabilities（含它认识哪些扩展）。
   * 带给适配器的运行时是原样的；带给原生 codex 之前先摘掉它不认识的扩展键
   */
  initializeParams: unknown
  /** 第 n 次失败后等多久再试，用完最后一个就一直用它 */
  retryMs: number[]
  handshakeTimeoutMs: number
  /**
   * 上游发来的帧，设备进程自己那些请求的应答除外。
   * request：这一帧是哪个转发过去的请求的应答（别的帧没有）
   */
  frame(link: UpstreamLink, frame: Frame, raw: string, request?: ForwardedRequest): void
  /** 可用状态变了，或者握手得到的信息变了 */
  status(link: UpstreamLink): void
  /** 断开了：这些已经转发出去的请求不会有应答了 */
  dropped(link: UpstreamLink, pending: ForwardedRequest[]): void
}

interface Waiting {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

const text = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * 连不上时给人看的那一句。只说是哪一类，不带系统给的原文：原文里有套接字的完整路径，
 * 这句话会原样显示在客户端的界面上。原文记在 UpstreamLink.detail 里，进设备进程的日志。
 */
function unreachable(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOENT') return '连不上这个运行时：它的套接字不在，多半是还没有启动'
  if (code === 'ECONNREFUSED') return '连不上这个运行时：没有进程在听它的套接字，多半是已经退出了'
  if (code === 'EACCES' || code === 'EPERM') return '连不上这个运行时：没有权限访问它的套接字'
  return typeof code === 'string' ? `连不上这个运行时（${code}）` : '连不上这个运行时'
}

export class UpstreamLink {
  readonly harness: string
  readonly dialect: UpstreamDialect
  facts: UpstreamFacts = { userAgent: null, runtime: null }
  failure: HarnessUnavailable = { kind: 'connecting', message: '正在连接这个运行时' }
  /** 最近一次失败时系统给的原文。只进日志，不给客户端（里面可能有路径） */
  detail: string | null = null
  /** 第一次尝试有了结果：握手完成，或者失败了 */
  readonly settled: Promise<void>
  private settle: () => void = () => {}
  private readonly options: LinkOptions
  private wire: Wire | null = null
  private ready = false
  private stopped = false
  private suspended = false
  private failures = 0
  private timer: NodeJS.Timeout | null = null
  private sequence = 0
  /** 每条上游连接一个代号。事件回来时代号对不上，说明那条连接已经作废 */
  private epoch = 0
  private readonly internal = new Map<string, Waiting>()
  private readonly forwarded = new Map<string, ForwardedRequest>()

  constructor(options: LinkOptions) {
    this.options = options
    this.harness = options.harness
    this.dialect = options.dialect
    this.settled = new Promise((resolve) => {
      this.settle = resolve
    })
  }

  get available(): boolean {
    return this.ready
  }

  start(): void {
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    this.epoch++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.ready = false
    this.wire?.close()
    this.wire = null
    this.rejectInternal(new Error('连接已关闭'))
    this.forwarded.clear()
    this.settle()
  }

  /** 适配器主进程说这个运行时没在跑，这条连接歇着，没有在连也不会去连 */
  get parked(): boolean {
    return this.suspended
  }

  /**
   * 适配器主进程说这个运行时现在没在跑（停用了、没装、没起来、正在起）：不再去连，原因照它说的报。
   * 这时候要是还连着，当作断开处理：已经转发出去的请求不会有应答了。
   */
  suspend(failure: HarnessUnavailable): void {
    if (this.stopped) return
    this.suspended = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const wire = this.wire
    this.epoch++
    this.ready = false
    this.wire = null
    this.failure = failure
    this.detail = null
    if (wire) {
      wire.close()
      this.rejectInternal(new Error('运行时已经停了'))
      const pending = [...this.forwarded.values()]
      this.forwarded.clear()
      this.options.dropped(this, pending)
    }
    this.settle()
    this.options.status(this)
  }

  /** 适配器主进程说这个运行时起来了：去连它。连上之前报的还是歇着时的原因 */
  resume(): void {
    if (!this.suspended || this.stopped) return
    this.suspended = false
    this.failures = 0
    void this.connect()
  }

  /** 设备进程自己向上游发一个请求（握手、合并列表、打听会话归属） */
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const wire = this.wire
    if (!wire) return Promise.reject(new Error('这个运行时现在没有连上'))
    const id = `${INTERNAL_ID_PREFIX}${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.internal.delete(id)
        reject(new Error(`${method} 等了 ${timeoutMs} 毫秒没有应答`))
      }, timeoutMs)
      timer.unref()
      this.internal.set(id, { resolve, reject, timer })
      wire.send(JSON.stringify({ id, method, params }))
    })
  }

  /** 把客户端的一个请求原样转给上游。上游不可用时返回 false，什么都没发 */
  forward(id: RpcId, method: string, raw: string): boolean {
    if (!this.ready || !this.wire) return false
    this.forwarded.set(idKey(id), { id, method })
    this.wire.send(raw)
    return true
  }

  /** 把客户端对服务端请求的应答送回上游 */
  reply(raw: string): void {
    this.wire?.send(raw)
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.suspended) return
    const epoch = ++this.epoch
    const stale = () => epoch !== this.epoch
    let wire: Wire
    try {
      wire = await this.options.connect({
        message: (raw) => {
          if (!stale()) this.receive(raw)
        },
        close: (reason) => {
          if (!stale()) this.lost(reason)
        },
      })
    } catch (error) {
      if (!stale()) this.fail('unreachable', unreachable(error), text(error))
      return
    }
    if (stale()) {
      wire.close()
      return
    }
    this.wire = wire
    try {
      const timeout = this.options.handshakeTimeoutMs
      const { dialect } = this
      const greeting = dialect.initializeParams(this.options.initializeParams)
      const init = await this.request('initialize', greeting, timeout)
      wire.send(JSON.stringify({ method: 'initialized' }))
      // 名字、版本和声明：适配器的运行时自己报（runtime/info），原生 codex 的由设备进程替它整理
      const runtime = await dialect.describe(init, (method, params) =>
        this.request(method, params, timeout),
      )
      if (stale()) return
      this.facts = {
        userAgent: isObject(init) && typeof init.userAgent === 'string' ? init.userAgent : null,
        runtime,
      }
      this.ready = true
      this.failures = 0
      this.detail = null
      this.settle()
      this.options.status(this)
    } catch (error) {
      // 连接在握手途中断了的话，lost 已经处理过，这里的代号对不上
      if (stale()) return
      this.epoch++
      this.wire = null
      wire.close()
      this.rejectInternal(new Error('握手失败'))
      this.fail('handshakeFailed', `和这个运行时握手没有成功：${text(error)}`)
    }
  }

  private receive(raw: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    if (!isObject(frame)) return
    if (typeof frame.method !== 'string' && frame.id != null) {
      const waiting = typeof frame.id === 'string' ? this.internal.get(frame.id) : undefined
      if (waiting && typeof frame.id === 'string') {
        this.internal.delete(frame.id)
        clearTimeout(waiting.timer)
        const error = frame.error
        if (isObject(error))
          waiting.reject(
            new UpstreamRpcError({
              code: typeof error.code === 'number' ? error.code : -32603,
              message: typeof error.message === 'string' ? error.message : '上游回了一个错误',
              data: error.data,
            }),
          )
        else waiting.resolve(frame.result)
        return
      }
      const key = idKey(frame.id)
      const request = this.forwarded.get(key)
      this.forwarded.delete(key)
      this.options.frame(this, frame as Frame, raw, request)
      return
    }
    this.options.frame(this, frame as Frame, raw)
  }

  private lost(reason: string): void {
    const wasReady = this.ready
    this.epoch++
    this.ready = false
    this.wire = null
    this.rejectInternal(new Error('连接断开了'))
    const pending = [...this.forwarded.values()]
    this.forwarded.clear()
    this.options.dropped(this, pending)
    if (wasReady) this.fail('disconnected', `和这个运行时的连接断开了，正在重连：${reason}`)
    else this.fail('handshakeFailed', `握手途中连接断开了：${reason}`)
  }

  private fail(kind: HarnessUnavailableKind, message: string, detail: string | null = null): void {
    this.failure = { kind, message }
    this.detail = detail
    this.settle()
    this.options.status(this)
    if (this.stopped || this.suspended) return
    const delays = this.options.retryMs
    const delay = delays[Math.min(this.failures, delays.length - 1)] ?? 1000
    this.failures++
    this.timer = setTimeout(() => {
      this.timer = null
      void this.connect()
    }, delay)
    this.timer.unref()
  }

  private rejectInternal(error: Error): void {
    for (const waiting of this.internal.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(error)
    }
    this.internal.clear()
  }
}
