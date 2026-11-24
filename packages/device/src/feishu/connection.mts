// 一个飞书应用一条长连接：包一层官方 SDK 的 WSClient 与 EventDispatcher，加设备自己的看门狗。
// 事件处理函数同步把事件写进本地库后才返回；SDK 拿到返回值才给飞书回 ACK，所以是“先落库再确认”。
import { EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk'
import type { FeishuConnection, FeishuErrorCode } from '../../../protocol/src/feishu.mjs'

export type FeishuEventHandler = (data: Record<string, unknown>) => Promise<unknown> | unknown

export interface FeishuConnectionOptions {
  appId: string
  secret: () => string
  /** 开放平台地址（测试里是回环假服务端） */
  domain: string
  handlers: Record<string, FeishuEventHandler>
  /** 状态变化（含每次收到事件更新的 lastEventAt） */
  changed: (connection: FeishuConnection) => void
  /** 每次连上（首次和重连）后调一次，用来补缺口 */
  connected: () => void
  log: (message: string) => void
  /** 毫秒 */
  now?: () => number
  watchdog?: {
    /** 多久检查一次 */
    checkMs?: number
    /** 连续多久没连上就重建客户端 */
    staleMs?: number
    /** SDK 放弃后的重建退避 */
    minBackoffMs?: number
    maxBackoffMs?: number
  }
}

const seconds = (ms: number) => Math.floor(ms / 1000)

function errorCode(message: string): { code: FeishuErrorCode; fatal: boolean } {
  // SDK 拉连接配置失败的消息形如 “pullConnectConfig failed: code=514, msg=…”
  const code = Number(/code=(\d+)/.exec(message)?.[1] ?? Number.NaN)
  if (code === 514 || code === 403) return { code: 'credential_rejected', fatal: true }
  if (code === 1000040350) return { code: 'connection_limit', fatal: false }
  if (Number.isFinite(code)) return { code: 'platform', fatal: false }
  return { code: 'network', fatal: false }
}

export class FeishuConnectionRunner {
  private readonly options: FeishuConnectionOptions
  private readonly now: () => number
  private client: WSClient | null = null
  private state: FeishuConnection
  private timer: NodeJS.Timeout | null = null
  private rebuildTimer: NodeJS.Timeout | null = null
  private backoff: number
  private closed = true
  private generation = 0

  constructor(options: FeishuConnectionOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.backoff = options.watchdog?.minBackoffMs ?? 5_000
    this.state = { state: 'stopped', since: seconds(this.now()), reconnects: 0 }
  }

  status(): FeishuConnection {
    return { ...this.state }
  }

  start(): void {
    if (!this.closed) return
    this.closed = false
    this.build()
    const check = this.options.watchdog?.checkMs ?? 30_000
    this.timer = setInterval(() => this.watch(), check)
    this.timer.unref()
  }

  close(): void {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer)
    this.timer = null
    this.rebuildTimer = null
    this.teardown()
    this.set({ state: 'stopped' })
  }

  private set(next: Partial<FeishuConnection> & { state?: FeishuConnection['state'] }): void {
    const changedState = next.state !== undefined && next.state !== this.state.state
    this.state = {
      ...this.state,
      ...next,
      ...(changedState ? { since: seconds(this.now()) } : {}),
    }
    if (next.state === 'connected') delete this.state.error
    this.options.changed(this.status())
  }

  private teardown(): void {
    const client = this.client
    this.client = null
    this.generation++
    try {
      client?.close({ force: true })
    } catch {}
  }

  private build(): void {
    this.teardown()
    const generation = this.generation
    const mine = () => !this.closed && generation === this.generation
    const dispatcher = new EventDispatcher({
      loggerLevel: LoggerLevel.error,
      logger: this.logger(),
    })
    const handlers: Record<string, (data: unknown) => Promise<unknown>> = {}
    for (const [type, handler] of Object.entries(this.options.handlers)) {
      handlers[type] = async (data: unknown) => {
        if (mine()) this.set({ lastEventAt: seconds(this.now()) })
        return await handler(data as Record<string, unknown>)
      }
    }
    dispatcher.register(handlers)
    this.set({ state: 'connecting' })
    const client = new WSClient({
      appId: this.options.appId,
      appSecret: this.options.secret(),
      domain: this.options.domain,
      loggerLevel: LoggerLevel.error,
      logger: this.logger(),
      autoReconnect: true,
      // 心跳发出后这么久没有任何入站帧，SDK 断开重连
      wsConfig: { pingTimeout: 30 },
      onReady: () => {
        if (!mine()) return
        this.backoff = this.options.watchdog?.minBackoffMs ?? 5_000
        this.set({ state: 'connected', lastConnectedAt: seconds(this.now()) })
        this.options.connected()
      },
      onReconnecting: () => {
        if (mine()) this.set({ state: 'reconnecting', reconnects: this.state.reconnects + 1 })
      },
      onReconnected: () => {
        if (!mine()) return
        this.set({ state: 'connected', lastConnectedAt: seconds(this.now()) })
        this.options.connected()
      },
      onError: (error: Error) => {
        if (!mine()) return
        const { code, fatal } = errorCode(error.message)
        this.options.log(`飞书长连接出错：${this.options.appId} ${code}`)
        this.set({ state: 'failed', error: { code, at: seconds(this.now()) } })
        if (!fatal) this.scheduleRebuild()
      },
    } as ConstructorParameters<typeof WSClient>[0])
    this.client = client
    void client.start({ eventDispatcher: dispatcher })
  }

  private scheduleRebuild(): void {
    if (this.closed || this.rebuildTimer) return
    const max = this.options.watchdog?.maxBackoffMs ?? 300_000
    const delay = Math.min(max, this.backoff) * (0.8 + Math.random() * 0.4)
    this.backoff = Math.min(max, this.backoff * 2)
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null
      if (!this.closed) this.build()
    }, delay)
    this.rebuildTimer.unref()
  }

  /** 看门狗：连接不在 connected 超过 staleMs 就丢掉旧客户端重建；凭据被拒的不重试，等用户处理 */
  private watch(): void {
    if (this.closed || this.state.state === 'connected') return
    if (this.state.error?.code === 'credential_rejected') return
    const stale = this.options.watchdog?.staleMs ?? 30 * 60_000
    if (this.now() - this.state.since * 1000 >= stale && !this.rebuildTimer) {
      this.options.log(`飞书长连接长时间未连上，重建：${this.options.appId}`)
      this.build()
    }
  }

  private logger() {
    // SDK 在 debug、info 级别会打出事件原文，这里只留错误级别，而且只记一行提示
    const sink =
      (level: string) =>
      (...args: unknown[]) => {
        if (level !== 'error') return
        const first = args.find((item) => typeof item === 'string' && item !== '[ws]')
        this.options.log(`飞书 SDK：${String(first ?? '').slice(0, 120)}`)
      }
    return {
      error: sink('error'),
      warn: sink('warn'),
      info: sink('info'),
      debug: sink('debug'),
      trace: sink('trace'),
    }
  }
}
