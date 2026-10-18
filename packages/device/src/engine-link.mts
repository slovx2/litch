// 【桩】这一份是丁线（会话树）在定时任务线的正式版合进 main 之前放的桩，照 11-scheduled-tasks.md“四之一”的签名写。
// 合并时删掉，换成定时任务线写的那份；本文件里多出来的东西（见下文“多给了”）要先跟它对齐。
//
// 设备进程自己开的引擎连接：没有客户端在中间，设备进程自己对引擎发起回合（派子会话、唤醒父会话、跑定时任务）。
// 和聚合面上的上游连接（upstream.mts，每条客户端连接一组、断了自己重连）不同，这条只有一份、断了就报 onClose，
// 要再用由调用方重新开。和 side-link.mts（问几句就关）也不同，它一直听着通知。
//
// 握手时声明能执行设备注册的那些 litch_ 命名空间（device-tools.mts），引擎挑执行方时挑得中这条连接；
// 收到的这类 item/tool/call 交给注册表。别的服务端请求（审批、提问、别的命名空间的工具）不答：
// 只由用户答，留给打开了那个会话的客户端（引擎会把还在等的请求补发给恢复会话的连接）。
//
// 和定时任务线约定的接口（design/harness-client/11-scheduled-tasks.md“四之一”）：EngineLink、runTurn 的名字不改，
// DeviceServer.openEngineLink(harness) 开一条。这里多给了 runtime、closed、onServerRequest，只增不改。
import type { DeviceToolRegistry, DeviceTools } from './device-tools.mjs'
import { declareDeviceTools } from './device-tools.mjs'
import type { UpstreamDialect } from './dialect.mjs'
import { type Connector, isObject, type RpcId, UpstreamRpcError, type Wire } from './wire.mjs'

export interface EngineLink {
  readonly harness: string
  /** 握手之后取到的声明（runtime/info 的形状）。拿不到是 null */
  readonly runtime: Record<string, unknown> | null
  /** 断了、关了 */
  readonly closed: boolean
  /** 上游回了错误时抛 UpstreamRpcError；超时、断开抛普通的 Error */
  request(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<any>
  /** 收通知；返回取消订阅 */
  onNotification(listener: (method: string, params: any) => void): () => void
  /** 对面发来、要答复的请求（设备注册的命名空间的工具调用除外）。这里不答，只给看 */
  onServerRequest(listener: (method: string, params: any, id: RpcId) => void): () => void
  /** 连接断了（引擎退出、设备进程关） */
  onClose(listener: (reason: string) => void): () => void
  close(): void
}

export interface EngineLinkOptions {
  harness: string
  connect: Connector
  dialect: UpstreamDialect
  version: string
  /** 握手和请求缺省等多久 */
  timeoutMs: number
  tools: DeviceToolRegistry & Pick<DeviceTools, 'dispatch' | 'turnEnded'>
}

interface Waiting {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export async function connectEngineLink(options: EngineLinkOptions): Promise<EngineLink> {
  const { harness, dialect, tools } = options
  const waiting = new Map<number, Waiting>()
  const notified = new Set<(method: string, params: unknown) => void>()
  const requested = new Set<(method: string, params: unknown, id: RpcId) => void>()
  const closing = new Set<(reason: string) => void>()
  let sequence = 0
  let closed = false
  let wire: Wire | null = null
  const fail = (error: Error) => {
    for (const entry of waiting.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    waiting.clear()
  }
  const lost = (reason: string) => {
    if (closed) return
    closed = true
    fail(new Error(`${harness} 的连接断开了：${reason}`))
    for (const listener of [...closing]) listener(reason)
  }
  const receive = (raw: string) => {
    let frame: unknown
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    if (!isObject(frame)) return
    if (typeof frame.method === 'string') {
      const params = isObject(frame.params) ? frame.params : {}
      if (frame.id == null) {
        if (frame.method === 'turn/completed' && isObject(params.turn))
          tools.turnEnded(harness, String(params.turn.id))
        for (const listener of [...notified]) listener(frame.method, params)
        return
      }
      const id = frame.id as RpcId
      if (frame.method === 'item/tool/call' && tools.has(params.namespace as string)) {
        tools.dispatch(harness, params, (result) => {
          if (closed || !wire) return false
          wire.send(JSON.stringify({ id, result }))
          return true
        })
        return
      }
      for (const listener of [...requested]) listener(frame.method, params, id)
      return
    }
    const entry = typeof frame.id === 'number' ? waiting.get(frame.id) : undefined
    if (!entry || typeof frame.id !== 'number') return
    waiting.delete(frame.id)
    clearTimeout(entry.timer)
    const error = frame.error
    if (isObject(error))
      entry.reject(
        new UpstreamRpcError({
          code: typeof error.code === 'number' ? error.code : -32603,
          message: typeof error.message === 'string' ? error.message : '上游回了一个错误',
          data: error.data,
        }),
      )
    else entry.resolve(frame.result)
  }
  wire = await options.connect({ message: receive, close: lost })
  const opened = wire
  const call = (method: string, params: unknown, timeoutMs: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error(`${harness} 的连接已经关了`))
        return
      }
      const id = ++sequence
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error(`${method} 等了 ${timeoutMs} 毫秒没有应答`))
      }, timeoutMs)
      timer.unref()
      waiting.set(id, { resolve, reject, timer })
      opened.send(JSON.stringify({ id, method, params }))
    })
  const close = () => {
    if (closed) return
    lost('设备进程关了这条连接')
    opened.close()
  }
  let runtime: Record<string, unknown> | null = null
  try {
    const greeting = dialect.initializeParams(
      declareDeviceTools(
        {
          clientInfo: { name: 'litch-device', title: null, version: options.version },
          // 队列、项目那几组方法在上游协议里标着实验性
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
        tools.namespaces(),
      ),
    )
    const init = await call('initialize', greeting, options.timeoutMs)
    opened.send(JSON.stringify({ method: 'initialized' }))
    runtime = await dialect.describe(init, (method, params) =>
      call(method, params, options.timeoutMs),
    )
  } catch (error) {
    close()
    throw error
  }
  const subscribe = <T,>(set: Set<T>, listener: T) => {
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }
  return {
    harness,
    runtime,
    get closed() {
      return closed
    },
    request: (method, params, more) => {
      const fields = isObject(params) ? params : null
      const sent = fields ? (dialect.outgoing(method, fields) ?? fields) : params
      return call(method, sent, more?.timeoutMs ?? options.timeoutMs)
    },
    onNotification: (listener) => subscribe(notified, listener),
    onServerRequest: (listener) => subscribe(requested, listener),
    onClose: (listener) => subscribe(closing, listener),
    close,
  }
}

export interface RunTurnResult {
  turnId: string
  status: 'completed' | 'failed' | 'interrupted' | 'timedOut'
  /** 这一回合最后一条回答的正文；没有回答是 null */
  lastMessage: string | null
  error: string | null
}

/**
 * 发一个回合并等它结束：turn/start，按 turnId 认 turn/completed，收集最后一条回答。
 * 这条连接要已经订阅着这个会话（新建、恢复、分叉过），不然收不到回合的通知（原生 codex 的 turn/start 不让发起的连接订阅）。
 * 到点没结束返回 timedOut，不去打断它；signal 作废时打断这个回合，返回 interrupted。
 */
export function runTurn(
  link: EngineLink,
  params: { threadId: string; input: unknown[]; overrides?: Record<string, unknown> },
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<RunTurnResult> {
  return new Promise((resolve, reject) => {
    let turnId: string | null = null
    let lastMessage: string | null = null
    let settled = false
    // turn/start 的应答到之前先到的通知攒着，认出回合号再看
    const early: { method: string; params: Record<string, unknown> }[] = []
    const cleanups: (() => void)[] = []
    const done = (result: RunTurnResult | Error) => {
      if (settled) return
      settled = true
      for (const cleanup of cleanups) cleanup()
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const look = (method: string, fields: Record<string, unknown>) => {
      if (fields.threadId !== params.threadId) return
      const item = isObject(fields.item) ? fields.item : null
      if (method === 'item/completed' && fields.turnId === turnId && item?.type === 'agentMessage')
        lastMessage = typeof item.text === 'string' ? item.text : lastMessage
      const turn = isObject(fields.turn) ? fields.turn : null
      if (method !== 'turn/completed' || turn?.id !== turnId) return
      const status =
        turn.status === 'failed' || turn.status === 'interrupted' ? turn.status : 'completed'
      const error =
        isObject(turn.error) && typeof turn.error.message === 'string' ? turn.error.message : null
      done({ turnId: turnId as string, status, lastMessage, error })
    }
    cleanups.push(
      link.onNotification((method, fields) => {
        if (turnId === null) early.push({ method, params: fields })
        else look(method, fields)
      }),
      link.onClose((reason) => done(new Error(`${link.harness} 的连接断开了：${reason}`))),
    )
    const timer = setTimeout(
      () => done({ turnId: turnId ?? '', status: 'timedOut', lastMessage, error: null }),
      options.timeoutMs,
    )
    timer.unref()
    cleanups.push(() => clearTimeout(timer))
    const abort = () => {
      if (turnId)
        link.request('turn/interrupt', { threadId: params.threadId, turnId }).catch(() => {})
      done({ turnId: turnId ?? '', status: 'interrupted', lastMessage, error: null })
    }
    if (options.signal?.aborted) return abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    cleanups.push(() => options.signal?.removeEventListener('abort', abort))
    link
      .request('turn/start', {
        ...params.overrides,
        threadId: params.threadId,
        input: params.input,
      })
      .then((result: unknown) => {
        const turn = isObject(result) && isObject(result.turn) ? result.turn : null
        if (typeof turn?.id !== 'string') throw new Error('turn/start 的应答里没有回合')
        turnId = turn.id
        for (const event of early.splice(0)) look(event.method, event.params)
      })
      .catch((error: unknown) => done(error instanceof Error ? error : new Error(String(error))))
  })
}
