// 设备进程跑定时任务时自己开的一条到运行时的连接，跑完一次运行就关。
// 和 side-link.mts 那种“问几句就关”的不同，它要一直听着：会话的通知（turn/completed、条目、状态）交给
// onNotification；运行时发来要答复的请求里，litch_tasks 的工具调用由设备进程自己答（onToolCall），
// 别的（审批、提问、别的命名空间的工具）不答，留给之后连上来的客户端，和引擎原有的做法一样。
// 握手时声明能执行 litch_tasks（clientTools 扩展），引擎挑执行方时挑得中这条连接。
import { CLIENT_TOOL_NAMESPACE, CLIENT_TOOLS_CAPABILITY } from '../../protocol/src/client-tools.mjs'
import { EXTENSION, EXTENSIONS_CAPABILITY } from '../../protocol/src/device.mjs'
import type { UpstreamDialect } from './dialect.mjs'
import {
  type Connector,
  type Frame,
  isObject,
  type RpcId,
  UpstreamRpcError,
  type Wire,
} from './wire.mjs'

export interface EngineLinkHandlers {
  /** 运行时发来的通知 */
  notification(method: string, params: Record<string, unknown>): void
  /** litch_tasks 的一次工具调用。reply 把答复送回这条连接 */
  toolCall(frame: Frame, reply: (result: unknown) => void): void
  /** 连接断了，或者自己关了 */
  lost(): void
}

export interface EngineLink {
  /** 握手之后取到的声明（runtime/info 的形状）。拿不到是 null */
  readonly runtime: Record<string, unknown> | null
  readonly dialect: UpstreamDialect
  /** 上游回了错误时抛 UpstreamRpcError；超时、断开抛普通的 Error */
  call(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>
  close(): void
}

/**
 * 设备进程替自己通往引擎的连接声明能执行 litch_tasks：在 litchExtensions 里加上 clientTools，
 * litchClientTools.namespaces 里加上 litch_tasks。客户端自己的声明照原样保留（它声明了别的命名空间的照旧）。
 * 原生 codex 不认识这两个键，它的“话”在握手前会摘掉（native-codex.mts），由设备进程自己拦它的调用。
 */
export function declareTasksTool(given: unknown): unknown {
  const fields = isObject(given) ? given : {}
  const capabilities = isObject(fields.capabilities) ? fields.capabilities : {}
  const listed = capabilities[EXTENSIONS_CAPABILITY]
  const extensions = Array.isArray(listed) ? [...listed] : []
  if (!extensions.includes(EXTENSION.clientTools)) extensions.push(EXTENSION.clientTools)
  const declared = capabilities[CLIENT_TOOLS_CAPABILITY]
  const tools = isObject(declared) ? declared : {}
  // 客户端没声明 clientTools 扩展时，它列的命名空间本来不算数，加上扩展之后也不能让它们算数
  const own =
    Array.isArray(listed) &&
    listed.includes(EXTENSION.clientTools) &&
    Array.isArray(tools.namespaces)
      ? tools.namespaces
      : []
  const namespaces = own.includes(CLIENT_TOOL_NAMESPACE.tasks)
    ? own
    : [...own, CLIENT_TOOL_NAMESPACE.tasks]
  return {
    ...fields,
    capabilities: {
      ...capabilities,
      [EXTENSIONS_CAPABILITY]: extensions,
      [CLIENT_TOOLS_CAPABILITY]: { ...tools, namespaces },
    },
  }
}

interface Waiting {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export async function openEngineLink(options: {
  connect: Connector
  dialect: UpstreamDialect
  version: string
  handshakeTimeoutMs: number
  handlers: EngineLinkHandlers
}): Promise<EngineLink> {
  const { dialect, handlers } = options
  const waiting = new Map<number, Waiting>()
  let sequence = 0
  let closed = false
  const fail = (error: Error) => {
    for (const entry of waiting.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    waiting.clear()
  }
  let wire: Wire | null = null
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
        handlers.notification(frame.method, params)
        return
      }
      if (frame.method === 'item/tool/call' && params.namespace === CLIENT_TOOL_NAMESPACE.tasks) {
        const id = frame.id as RpcId
        handlers.toolCall(frame as Frame, (result) => {
          if (!closed) wire?.send(JSON.stringify({ id, result }))
        })
      }
      // 别的请求不答：审批、提问留给之后连上来的客户端（引擎会补发给恢复会话的连接）
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
  wire = await options.connect({
    message: receive,
    close: () => {
      if (closed) return
      closed = true
      fail(new Error('连接断开了'))
      handlers.lost()
    },
  })
  const opened = wire
  const call = (method: string, params: unknown, timeoutMs: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error('连接已经关了'))
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
  // 自己关的也告诉 lost：还在等回合的那一头立刻醒来（设备进程退出时）
  const close = () => {
    if (closed) return
    closed = true
    fail(new Error('连接已经关了'))
    opened.close()
    handlers.lost()
  }
  let runtime: Record<string, unknown> | null = null
  try {
    const greeting = dialect.initializeParams(
      declareTasksTool({
        clientInfo: { name: 'litch-device-tasks', title: null, version: options.version },
        // 项目、队列那几组方法在上游协议里标着实验性
        capabilities: { experimentalApi: true, requestAttestation: false },
      }),
    )
    const init = await call('initialize', greeting, options.handshakeTimeoutMs)
    opened.send(JSON.stringify({ method: 'initialized' }))
    runtime = await dialect.describe(init, (method, params) =>
      call(method, params, options.handshakeTimeoutMs),
    )
  } catch (error) {
    close()
    throw error
  }
  return {
    runtime,
    dialect,
    call: (method, params, timeoutMs) =>
      call(method, dialect.outgoing(method, params) ?? params, timeoutMs),
    close,
  }
}
