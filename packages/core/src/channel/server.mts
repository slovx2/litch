// 通道的核心一侧：把端口上的消息交给核心处理，把核心给的快照和增量发回去。
// 增量在这里按帧合并：同一帧内到达的多段文本合成一条再发；
// 接到命令输出上的字并起来太长时只发头尾（见 createOpQueue），一帧发给界面的量有上限，不随输出来得多快涨。
//
// 增量是值：交进来的那一刻就拷一份再排队。它要在这里最多等一帧才发出去，这期间核心照样在改自己手里的东西，
// 排着的这一份不能跟着变。快照是当场发的，端口在发出的那一刻取值（Port.post 的约定），不用另外拷。
import { extendSkipping, type SkippingOutput, skipOutput } from '../text/output-cap.mjs'
import { type CoreTrace, traceError, traceIds } from '../trace.mjs'
import { copyValue } from '../value.mjs'
import { createCancel } from './cancel.mjs'
import {
  type AbortSignalLike,
  ChannelError,
  type ClientMessage,
  type Clock,
  type Port,
  type ServerMessage,
  type Topic,
  toChannelError,
} from './protocol.mjs'

/** 核心对通道暴露的两个入口。真正的核心和模拟核心都实现它 */
export interface CoreHost {
  command(name: string, params: unknown, signal: AbortSignalLike): Promise<unknown>
  /**
   * 建立订阅。实现方要先调一次 snapshot，再调 delta；返回退订函数。
   * 快照可以晚一点再给（要先向设备取数据的时候）。
   * 主题不存在时直接抛 ChannelError；之后才出的错走 sink.error。
   */
  subscribe(topic: Topic, sink: HostSink): () => void
}

export interface HostSink {
  snapshot(data: unknown): void
  delta(ops: unknown[]): void
  /** 订阅建立之后才发现给不了数据（例如向设备要会话内容失败了）。调用后这个订阅就结束了 */
  error(error: ChannelError): void
}

export interface ServeOptions {
  clock: Clock
  /** 合并增量的时间窗，默认 16 毫秒（一帧） */
  frameMs?: number
  /** 界面命令的摘要（名字、标识字段、成败、耗时、错误原文）。不给就不记 */
  trace?: CoreTrace
}

/** 太密的界面命令不记：终端的按键、改尺寸、确认收到输出、重画 */
const UNTRACED_COMMANDS = new Set([
  'terminal.write',
  'terminal.resize',
  'terminal.ack',
  'terminal.redraw',
])

interface TextAppend {
  op: 'item.appendText'
  itemId: string
  field: string
  text: string
}

type OutputSkip = { op: 'item.appendOutput'; itemId: string } & SkippingOutput

function isTextAppend(op: unknown): op is TextAppend {
  return (
    typeof op === 'object' &&
    op !== null &&
    (op as { op?: unknown }).op === 'item.appendText' &&
    typeof (op as { itemId?: unknown }).itemId === 'string' &&
    typeof (op as { text?: unknown }).text === 'string'
  )
}

/** 整个换掉一个条目的增量换的是哪个条目。不是这种增量是 null */
function replacedItem(op: unknown): string | null {
  if (typeof op !== 'object' || op === null || (op as { op?: unknown }).op !== 'item.add')
    return null
  const id = (op as { item?: { id?: unknown } }).item?.id
  return typeof id === 'string' ? id : null
}

/** 往命令输出上接字的一条（还是整段的，或者已经只留头尾的）再接一段：并起来太长就只留头尾 */
function growOutput(last: TextAppend | OutputSkip, text: string): TextAppend | OutputSkip {
  if (last.op === 'item.appendOutput') return { ...last, ...extendSkipping(last, text) }
  const joined = last.text + text
  const skipping = skipOutput(joined)
  return skipping
    ? { op: 'item.appendOutput', itemId: last.itemId, ...skipping }
    : { ...last, text: joined }
}

/** 一帧里排着要发的增量 */
export interface OpQueue {
  /** 并进来。放进队列的是拷出来的一份，交进来的对象之后再怎么变都和队列无关 */
  push(ops: unknown[]): void
  /** 取走排着的，队列清空 */
  take(): unknown[]
  /** 丢掉排着的（快照已经包含了它们） */
  clear(): void
  readonly length: number
}

/**
 * 一帧的增量队列。追加文本的并法：同一条目同一字段的追加，并进队列里它的上一条追加，
 * 只要这中间没有整个换掉这个条目的增量（item.add）——别的增量（别的条目、这个条目的状态、撤掉回合）
 * 和往这个条目上接字谁先谁后结果都一样，所以几条命令的输出交错着来也各并各的。
 * 接到命令输出上的字并起来超过 SKIP_AT 时只留头尾（text/output-cap.mts 的 skipOutput），
 * 界面那头用 appendSkipping 接，结果和整段接的一样；这样一帧里发给界面的输出至多八九万个字，
 * 不管这一帧里来了多少。并的时候每个字只碰常数次
 */
export function createOpQueue(): OpQueue {
  let queue: unknown[] = []
  /** 每个“条目 + 字段”最后一条追加在队列里的位置 */
  let appends = new Map<string, number>()
  const reset = () => {
    queue = []
    appends = new Map()
  }
  return {
    push(incoming) {
      for (const op of incoming) {
        if (isTextAppend(op)) {
          const key = `${op.itemId}\n${op.field}`
          const at = appends.get(key)
          const last = at === undefined ? undefined : (queue[at] as TextAppend | OutputSkip)
          if (at !== undefined && last) {
            queue[at] =
              op.field === 'output'
                ? growOutput(last, op.text)
                : { ...last, text: (last as TextAppend).text + op.text }
          } else {
            appends.set(key, queue.length)
            queue.push(op.field === 'output' ? growOutput({ ...op, text: '' }, op.text) : { ...op })
          }
          continue
        }
        const replaced = replacedItem(op)
        if (replaced !== null) {
          appends.delete(`${replaced}\ntext`)
          appends.delete(`${replaced}\noutput`)
        }
        queue.push(copyValue(op))
      }
    },
    take() {
      const taken = queue
      reset()
      return taken
    },
    clear: reset,
    get length() {
      return queue.length
    },
  }
}

interface Subscription {
  close(): void
}

export function serveChannel(port: Port, host: CoreHost, options: ServeOptions): () => void {
  const frameMs = options.frameMs ?? 16
  const commands = new Map<number, { abort(): void }>()
  const subscriptions = new Map<number, Subscription>()
  let closed = false

  const send = (message: ServerMessage) => {
    if (!closed) port.post(message)
  }

  const trace = options.trace
  const runCommand = (id: number, name: string, params: unknown) => {
    const cancel = createCancel()
    commands.set(id, cancel)
    const at = options.clock.now()
    const record =
      trace && !UNTRACED_COMMANDS.has(name)
        ? (error: ChannelError | null) =>
            trace(
              'command',
              {
                command: name,
                ...traceIds(params),
                ok: error === null,
                ms: options.clock.now() - at,
                ...(error ? { code: error.code, error: traceError(error.message) } : {}),
              },
              error ? 'warn' : 'info',
            )
        : null
    host.command(name, params, cancel.signal).then(
      (result) => {
        record?.(null)
        // 已经取消的命令不再回应答，界面那边早就结束了
        if (commands.delete(id)) send({ t: 'res', id, ok: true, result })
      },
      (error: unknown) => {
        const failure = toChannelError(error)
        record?.(failure)
        if (commands.delete(id)) {
          send({ t: 'res', id, ok: false, error: failure.toShape() })
        }
      },
    )
  }

  const openSubscription = (id: number, topic: Topic) => {
    const queue = createOpQueue()
    let stopTimer: (() => void) | null = null
    let alive = true

    const flush = () => {
      stopTimer = null
      if (!alive || queue.length === 0) return
      send({ t: 'delta', id, ops: queue.take() })
    }

    const sink: HostSink = {
      snapshot(data) {
        if (!alive) return
        // 快照之前攒下的增量已经包含在快照里，丢掉
        queue.clear()
        send({ t: 'snap', id, data })
      },
      delta(ops) {
        if (!alive || ops.length === 0) return
        queue.push(ops)
        stopTimer ??= options.clock.setTimer(flush, frameMs)
      },
      error(error) {
        if (!alive) return
        send({ t: 'subError', id, error: error.toShape() })
        const entry = subscriptions.get(id)
        subscriptions.delete(id)
        if (entry) entry.close()
        else alive = false
      },
    }

    let unsubscribe: () => void
    try {
      unsubscribe = host.subscribe(topic, sink)
    } catch (error) {
      alive = false
      send({ t: 'subError', id, error: toChannelError(error).toShape() })
      return
    }
    // 实现方在建立订阅的过程中就报了错：订阅已经结束，不登记
    if (!alive) {
      unsubscribe()
      return
    }

    subscriptions.set(id, {
      close() {
        alive = false
        stopTimer?.()
        stopTimer = null
        unsubscribe()
      },
    })
  }

  port.listen((raw) => {
    if (closed) return
    const message = raw as ClientMessage
    switch (message.t) {
      case 'cmd':
        runCommand(message.id, message.name, message.params)
        return
      case 'cancel': {
        const entry = commands.get(message.id)
        commands.delete(message.id)
        entry?.abort()
        return
      }
      case 'sub':
        if (subscriptions.has(message.id)) {
          const error = new ChannelError('internal', `订阅编号重复：${message.id}`)
          send({ t: 'subError', id: message.id, error: error.toShape() })
          return
        }
        openSubscription(message.id, message.topic)
        return
      case 'unsub': {
        const entry = subscriptions.get(message.id)
        subscriptions.delete(message.id)
        entry?.close()
        return
      }
    }
  })

  // 界面那头断开（窗口关了）时由外壳调用：取消进行中的命令，退掉全部订阅
  return () => {
    if (closed) return
    closed = true
    for (const entry of commands.values()) entry.abort()
    commands.clear()
    for (const entry of subscriptions.values()) entry.close()
    subscriptions.clear()
    port.close()
  }
}
