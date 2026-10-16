// 通道的界面一侧：把命令和订阅变成端口上的消息，把收到的消息派发回去。
import {
  type AbortSignalLike,
  ChannelError,
  type ChannelErrorShape,
  type ClientMessage,
  type CommandName,
  type Commands,
  type Port,
  type ServerMessage,
  type Topic,
  type TopicData,
  type TopicKind,
  type TopicOp,
} from './protocol.mjs'

export interface TopicSink<K extends TopicKind> {
  /** 订阅建立后先来一份快照；之后的增量都基于它 */
  snapshot(data: TopicData[K]): void
  delta(ops: TopicOp[K][]): void
  error?(error: ChannelError): void
}

export interface CoreChannel {
  command<K extends CommandName>(
    name: K,
    params: Commands[K]['params'],
    options?: { signal?: AbortSignalLike },
  ): Promise<Commands[K]['result']>
  /** 返回退订函数 */
  subscribe<K extends TopicKind>(topic: Extract<Topic, { kind: K }>, sink: TopicSink<K>): () => void
  close(): void
}

interface PendingCommand {
  resolve(result: unknown): void
  reject(error: ChannelError): void
}

interface AnySink {
  snapshot(data: unknown): void
  delta(ops: unknown[]): void
  error?(error: ChannelError): void
}

/** 线上的错误变回错误对象。核心说了是哪一句的，那一句跟着过来 */
const fromShape = (shape: ChannelErrorShape): ChannelError =>
  new ChannelError(shape.code, shape.message, shape.text, {
    ...(shape.said ? { said: shape.said } : {}),
    ...(shape.key === undefined ? {} : { key: shape.key }),
  })

export function connectChannel(port: Port): CoreChannel {
  let nextId = 1
  let closed = false
  const pending = new Map<number, PendingCommand>()
  const sinks = new Map<number, AnySink>()

  const send = (message: ClientMessage) => port.post(message)

  port.listen((raw) => {
    const message = raw as ServerMessage
    switch (message.t) {
      case 'res': {
        const entry = pending.get(message.id)
        if (!entry) return
        pending.delete(message.id)
        if (message.ok) entry.resolve(message.result)
        else entry.reject(fromShape(message.error))
        return
      }
      case 'snap':
        sinks.get(message.id)?.snapshot(message.data)
        return
      case 'delta':
        sinks.get(message.id)?.delta(message.ops)
        return
      case 'subError': {
        const sink = sinks.get(message.id)
        sinks.delete(message.id)
        sink?.error?.(fromShape(message.error))
        return
      }
    }
  })

  return {
    command(name, params, options) {
      if (closed) return Promise.reject(new ChannelError('closed', '通道已经关闭'))
      const signal = options?.signal
      if (signal?.aborted) return Promise.reject(new ChannelError('cancelled', '命令已取消'))
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (result: unknown) => void, reject })
        // 取消后不等对面的应答，立刻结束；对面晚到的应答因为找不到编号被丢掉
        signal?.addEventListener(
          'abort',
          () => {
            if (!pending.delete(id)) return
            send({ t: 'cancel', id })
            reject(new ChannelError('cancelled', '命令已取消'))
          },
          { once: true },
        )
        send({ t: 'cmd', id, name, params })
      })
    },

    subscribe(topic, sink) {
      if (closed) {
        sink.error?.(new ChannelError('closed', '通道已经关闭'))
        return () => {}
      }
      const id = nextId++
      sinks.set(id, sink as AnySink)
      send({ t: 'sub', id, topic })
      return () => {
        if (!sinks.delete(id)) return
        if (!closed) send({ t: 'unsub', id })
      }
    },

    close() {
      if (closed) return
      closed = true
      const error = new ChannelError('closed', '通道已经关闭')
      for (const entry of pending.values()) entry.reject(error)
      pending.clear()
      for (const sink of sinks.values()) sink.error?.(error)
      sinks.clear()
      port.close()
    },
  }
}
