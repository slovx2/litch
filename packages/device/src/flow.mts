// 一条连接上的流量控制（设计文档 03 第十节第 5 条）：进程的输出经它发出去，它看着这条连接的发送积压，
// 过了线就算“堵着”，降下来再放开。堵着的时候该怎么办（按住进程不读、还是让这条连接落在后面）
// 由用它的地方决定：连接自己的进程在 device-layer.mts，属于设备的进程在 device-processes.mts。
import type { WireMessage } from '../../shared/src/types.mjs'

export interface FlowLimits {
  /** 积压到了这么多字节就算堵着 */
  highBytes: number
  /** 降到这么多字节以下才算通了。比上面那条低，免得在线上来回抖 */
  lowBytes: number
}

/**
 * 线定得低：堵着的时候进程被按住，用户按下的中断要等积压降下来才到得了伪终端的桥，
 * 积压留得越多，中断显得越迟钝。本机上积压几乎一直是零，线高线低不影响吞吐。
 */
export const DEFAULT_FLOW: FlowLimits = { highBytes: 256 * 1024, lowBytes: 64 * 1024 }

/** 流量控制眼里的一条连接 */
export interface FlowTarget {
  /** flushed：这一帧（连同排在它前面的）已经交给系统了 */
  send(message: WireMessage, flushed?: () => void): void
  /** 已经交出去、系统还没有收下的字节数 */
  backlog(): number
}

/** 堵着的时候，排在后面的要是别处发的帧（没有人在它写完时来叫），隔这么久自己再看一眼 */
const RECHECK_MS = 20

export class ConnectionFlow {
  private readonly target: FlowTarget
  private readonly limits: FlowLimits
  private blocked = false
  private closed = false
  private timer: NodeJS.Timeout | null = null
  private listeners: (() => void)[] = []

  constructor(target: FlowTarget, limits: FlowLimits = DEFAULT_FLOW) {
    this.target = target
    this.limits = limits
  }

  /** 现在是不是堵着：是的话先别再往这条连接上发进程的输出 */
  get congested(): boolean {
    return this.blocked
  }

  /** 连接还在 */
  get open(): boolean {
    return !this.closed
  }

  /** 发一帧进程的输出，顺便看一眼积压 */
  send(message: WireMessage): void {
    if (this.closed) return
    this.target.send(message, this.flushed)
    if (!this.blocked && this.target.backlog() >= this.limits.highBytes) this.blocked = true
  }

  /** 每一帧写完都来看一眼，所以积压一降到线下就能知道，不用等 */
  private readonly flushed = (): void => {
    if (this.blocked) this.recheck()
  }

  private recheck(): void {
    if (!this.blocked || this.closed) return
    if (this.target.backlog() > this.limits.lowBytes) {
      this.timer ??= setTimeout(() => {
        this.timer = null
        this.recheck()
      }, RECHECK_MS)
      return
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.blocked = false
    const order = this.listeners
    // 轮着来：这一次排在最前面的下一次排到最后。同一条连接上有几个进程在出输出时，
    // 排在前面的那个一发就又把连接堵上，不轮的话后面的永远轮不到
    if (order.length > 1) this.listeners = [...order.slice(1), order[0] as () => void]
    for (const listener of order) listener()
  }

  /** 从堵着变成通了的时候调用。返回值用来取消 */
  onDrain(listener: () => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener)
    }
  }

  /** 连接断了 */
  close(): void {
    this.closed = true
    this.blocked = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.listeners = []
  }
}
