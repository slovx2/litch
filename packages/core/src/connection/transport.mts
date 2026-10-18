// 连接层的最下面一层：传输。它只是一条已经打开的双向文本帧通道，一帧一条 JSON。
// 怎么打开（本机套接字、ssh 的标准输入输出）是平台的事，由外壳实现后注入，核心只认这个接口。
import type { AbortSignalLike } from '../channel/protocol.mjs'
import type { ConnectGuide, ConnectStage } from '../model.mjs'
import { describeText, type Text } from '../phrase.mjs'

export interface TransportHandlers {
  message(text: string): void
  /** 通道断了。reason 是给人看的原因，正常关闭时为 null */
  close(reason: Text | null): void
}

export interface Transport {
  send(text: string): void
  /** 只调用一次。打开之后、调用这个之前到达的帧由实现负责留着 */
  listen(handlers: TransportHandlers): void
  close(): void
}

/** 在哪一步失败（ConnectStage）见 model.mts */
export class ConnectError extends Error {
  readonly stage: ConnectStage
  /** 重试有没有意义。没装、版本低这类要人处理的，自动重连只会白转 */
  readonly retriable: boolean
  /** 给人看的原因。message 是它不依赖语言的写法，只进日志 */
  readonly text: Text
  /** 对面原话的末尾（ssh 的报错、服务的日志）。只给界面的“详情”用，不进日志 */
  readonly detail: string | null
  /** 该给人看哪一份“怎么办”（见 ConnectGuide）。不给就由界面按阶段定 */
  readonly guide: ConnectGuide | null

  constructor(
    stage: ConnectStage,
    text: Text,
    retriable = true,
    detail: string | null = null,
    guide: ConnectGuide | null = null,
  ) {
    super(describeText(text))
    this.name = 'ConnectError'
    this.stage = stage
    this.text = text
    this.retriable = retriable
    this.detail = detail
    this.guide = guide
  }
}

/**
 * 打开一条传输。失败时抛 ConnectError；别的错误一律按“连不到”处理。
 * 要走好几步才打得开的（远程设备）用 report 说一声现在到了哪一步。
 */
export type TransportOpener = (
  signal: AbortSignalLike,
  report?: (step: Text) => void,
) => Promise<Transport>

export function toConnectError(
  error: unknown,
  fallback: ConnectStage = 'unreachable',
): ConnectError {
  if (error instanceof ConnectError) return error
  return new ConnectError(fallback, error instanceof Error ? error.message : String(error))
}

/**
 * 同线程的一对传输，测试和“核心与对面在同一个线程”的场合用。
 * 送达是异步的，和真实的传输一致；任何一头关闭，另一头都会收到关闭。
 */
export function createTransportPair(): [Transport, Transport] {
  const queue = (run: () => void) => {
    void Promise.resolve().then(run)
  }
  const make = () => {
    let handlers: TransportHandlers | null = null
    let closed = false
    const backlog: string[] = []
    const end = {
      deliver(text: string) {
        if (closed) return
        if (handlers) handlers.message(text)
        else backlog.push(text)
      },
      shut(reason: string | null) {
        if (closed) return
        closed = true
        handlers?.close(reason)
      },
      isClosed: () => closed,
      attach(next: TransportHandlers) {
        handlers = next
        for (const text of backlog.splice(0)) next.message(text)
      },
    }
    return end
  }
  const a = make()
  const b = make()
  const wrap = (self: ReturnType<typeof make>, other: ReturnType<typeof make>): Transport => ({
    send(text) {
      if (self.isClosed()) return
      queue(() => other.deliver(text))
    },
    listen(handlers) {
      self.attach(handlers)
    },
    close() {
      if (self.isClosed()) return
      self.shut(null)
      queue(() => other.shut(null))
    },
  })
  return [wrap(a, b), wrap(b, a)]
}
