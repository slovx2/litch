// 和适配器主进程（Go 层的常驻服务）之间的控制通道。
// 运行时由主进程起和停，设置也由它读写；客户端连的却是设备进程。所以设备进程把
// “读写设置、重新应用、诊断、读日志、取 ssh 配置”经这条通道转给主进程，
// 主进程把每个 harness 的状态和设置的现状推过来。
//
// 通道是主进程在设备进程的状态目录里监听的一个本机套接字（ctl.sock），线上一行一条 JSON：
//   设备进程 → 主进程   {"id":N,"method":"settings.read","params":{…}}
//   主进程 → 设备进程   {"id":N,"result":{…}} 或 {"id":N,"error":{"reason":"…","text":{…},…}}
//   主进程 → 设备进程   {"method":"state","params":{…}}（连上时一次，之后每变一次一条）
// 主进程也有要问设备进程的事（现在只有一件：忙不忙，device-stop --if-idle 停服务之前要看）：
//   主进程 → 设备进程   {"ask":N,"method":"activity"}
//   设备进程 → 主进程   {"reply":N,"result":{…}} 或 {"reply":N,"error":"…"}
// 请求的参数里可能有密钥，这里不往日志里写任何消息的内容。
import net from 'node:net'
import type { DeviceServiceInfo } from '../../protocol/src/device-service.mjs'
import type {
  DeviceSettingsSnapshot,
  LocalizedText,
  ManagedHarnessState,
} from '../../protocol/src/device-settings.mjs'
import type { ProcessLimits } from './device-processes.mjs'
import { isObject } from './wire.mjs'

/** 主进程眼里的一个 harness */
export interface ManagedHarness {
  id: string
  /** 它的运行时在哪个套接字上，写法和 --upstream 一样（unix://路径）。没在跑时那里没有东西 */
  socket: string
  state: ManagedHarnessState
  /** 不在运行时的说明 */
  text: LocalizedText | null
  /** 它的运行时是原生的 codex，不是适配器：不认识我们的协议扩展，声明由设备进程替它整理 */
  native?: boolean
}

export interface ControlState {
  /** 这一次改了的设置键；只是状态变了时是空的 */
  keys: string[]
  /** 这台设备上全部已知的 harness，顺序就是对外报告的顺序 */
  harnesses: ManagedHarness[]
  snapshot: DeviceSettingsSnapshot
  /**
   * 属于设备的进程（可重连的终端）现行的上限和期限，出自设置里 processes.* 那一组。
   * 设备进程启动时命令行上已经带了一份；设置改了不重启设备进程，靠这里当场换。
   */
  processes?: Partial<ProcessLimits>
  /**
   * 主进程自己的来历（哪个版本、从哪份适配器起的、什么时候起的），服务启动时定下来就不变。
   * 声明了 deviceService 扩展的客户端在 runtime/info 里看得到（service-info.mts）。
   * 多出来的 options 是它启动时带的参数，只在本机用，不对客户端报。
   */
  service?: DeviceServiceInfo & { options?: string[] }
}

export interface ControlFailureDetail {
  /** unavailable 是这一头自己判断的：通道没连上，或者等应答的时候断了、超时了 */
  reason: 'conflict' | 'invalid' | 'unknownHarness' | 'failed' | 'unavailable'
  text: LocalizedText
  key?: string
  harness?: string
  snapshot?: DeviceSettingsSnapshot
}

export class ControlFailure extends Error {
  readonly detail: ControlFailureDetail

  constructor(detail: ControlFailureDetail) {
    super(detail.text['zh-CN'])
    this.detail = detail
  }
}

export interface ControlChannel {
  /** 最近一次收到的状态。还没有收到过是 null */
  readonly state: ControlState | null
  /** 收到一条新的状态时调用 */
  onState: ((state: ControlState) => void) | null
  /** 主进程来问一件事时调用，给出的就是回答；抛出来的、没有人接的，都按答不上回给它 */
  onAsk: ((method: string) => Promise<unknown>) | null
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>
  close(): void
}

const unavailable = (zh: string, en: string): ControlFailure =>
  new ControlFailure({ reason: 'unavailable', text: { 'zh-CN': zh, en } })

interface Waiting {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

/** 经本机套接字连到主进程。断了就隔一阵重连，连上之后主进程会重新给一份完整的状态 */
export class SocketControl implements ControlChannel {
  state: ControlState | null = null
  onState: ((state: ControlState) => void) | null = null
  onAsk: ((method: string) => Promise<unknown>) | null = null
  private readonly path: string
  private readonly log: (line: string) => void
  private readonly retryMs: number
  private socket: net.Socket | null = null
  private connected = false
  private closed = false
  private timer: NodeJS.Timeout | null = null
  private sequence = 0
  private readonly waiting = new Map<number, Waiting>()
  private readonly first: Promise<void>
  private arrived: () => void = () => {}

  constructor(path: string, log: (line: string) => void, retryMs = 1000) {
    this.path = path
    this.log = log
    this.retryMs = retryMs
    this.first = new Promise((resolve) => {
      this.arrived = resolve
    })
  }

  start(): void {
    this.connect()
  }

  /** 等第一条状态，最多等这么久。等到了返回 true */
  ready(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      void this.first.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const socket = this.socket
    if (!socket || !this.connected)
      return Promise.reject(
        unavailable(
          '和适配器主进程的控制通道没有连上',
          'The control channel to the adapter service is not connected',
        ),
      )
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(
          unavailable(
            `适配器主进程 ${Math.round(timeoutMs / 1000)} 秒没有应答`,
            `The adapter service did not answer within ${Math.round(timeoutMs / 1000)} seconds`,
          ),
        )
      }, timeoutMs)
      timer.unref()
      this.waiting.set(id, { resolve, reject, timer })
      socket.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.socket?.destroy()
    this.drop()
  }

  private connect(): void {
    if (this.closed) return
    const socket = net.createConnection(this.path)
    this.socket = socket
    socket.setEncoding('utf8')
    let buffer = ''
    socket.once('connect', () => {
      this.connected = true
      this.log('控制通道连上了')
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (line.trim()) this.receive(line)
      }
    })
    socket.on('error', () => {})
    socket.once('close', () => {
      if (this.socket !== socket) return
      if (this.connected) this.log('控制通道断开了')
      this.drop()
      if (this.closed) return
      this.timer = setTimeout(() => {
        this.timer = null
        this.connect()
      }, this.retryMs)
      this.timer.unref()
    })
  }

  /** 通道没了：等着应答的请求都落空 */
  private drop(): void {
    this.connected = false
    this.socket = null
    for (const entry of this.waiting.values()) {
      clearTimeout(entry.timer)
      entry.reject(
        unavailable(
          '和适配器主进程的控制通道断开了',
          'The control channel to the adapter service was lost',
        ),
      )
    }
    this.waiting.clear()
  }

  private receive(line: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      return
    }
    if (!isObject(frame)) return
    if (frame.method === 'state' && isObject(frame.params)) {
      this.state = frame.params as unknown as ControlState
      this.arrived()
      this.onState?.(this.state)
      return
    }
    if (typeof frame.ask === 'number') {
      if (typeof frame.method === 'string') void this.answer(frame.ask, frame.method)
      return
    }
    const entry = typeof frame.id === 'number' ? this.waiting.get(frame.id) : undefined
    if (!entry || typeof frame.id !== 'number') return
    this.waiting.delete(frame.id)
    clearTimeout(entry.timer)
    if (isObject(frame.error))
      entry.reject(new ControlFailure(frame.error as unknown as ControlFailureDetail))
    else entry.resolve(frame.result)
  }

  /** 主进程问了一件事：答在问它的那条连接上。连接中途断了就不答了，主进程那一头自己知道 */
  private async answer(ask: number, method: string): Promise<void> {
    const socket = this.socket
    let reply: { reply: number; result: unknown } | { reply: number; error: string }
    try {
      if (!this.onAsk) throw new Error('没有人接')
      reply = { reply: ask, result: await this.onAsk(method) }
    } catch (error) {
      reply = { reply: ask, error: error instanceof Error ? error.message : String(error) }
    }
    if (socket && this.socket === socket && this.connected)
      socket.write(`${JSON.stringify(reply)}\n`)
  }
}
