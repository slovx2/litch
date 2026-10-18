// 由设备进程自己执行的 litch_ 命名空间（litch_tasks、会话树的 litch_sessions……）。
// 各模块把处理函数注册进来；调用从哪来都交到这里：
//   - 客户端连接对应的上游连接上发来的 item/tool/call：不分适配器的引擎还是原生 codex，都在 relay.mts 的
//     serverRequest 开头按 has(namespace) 截下（原生 codex 把同一次调用发给每条订阅着会话的连接，几份都到这里）；
//   - 设备进程自己开的内部连接（engine-link.mts）。
// 设备进程替每条通往引擎的连接在握手里声明这些命名空间（declareDeviceTools），引擎挑执行方时挑得中它。
// 同一次调用（harness + 会话 + callId）只执行一次，答复从最先到的那份所在的连接回（它断了换下一份）：
// 原生 codex 的答复从哪条连接回去都算数。处理函数抛错时替它回 failed；回合结束（turn/completed）时
// 它拿到的 signal 作废（litch_sessions.wait 这种会等的工具要看它），设备进程关的时候也作废。
import {
  CLIENT_TOOL_NAMESPACE_PREFIX,
  CLIENT_TOOLS_CAPABILITY,
  type ClientToolCallResponse,
  clientToolFailure,
} from '../../protocol/src/client-tools.mjs'
import { EXTENSION, EXTENSIONS_CAPABILITY } from '../../protocol/src/device.mjs'
import { isObject } from './wire.mjs'

/** 一次调用。arguments 是模型给的原样参数 */
export interface DeviceToolCall {
  harness: string
  threadId: string
  turnId: string
  callId: string
  namespace: string
  tool: string
  arguments: unknown
}

/** 处理函数。返回的就是 item/tool/call 的答复（ClientToolCallResponse）；抛错时注册表替它回失败 */
export type DeviceToolHandler = (
  call: DeviceToolCall,
  context: { signal: AbortSignal },
) => Promise<ClientToolCallResponse>

export interface DeviceToolRegistry {
  /** 命名空间必须以 litch_ 开头；同一个注册两次抛错 */
  register(namespace: string, handler: DeviceToolHandler): void
  /** 已注册的命名空间：设备进程替每条通往引擎的连接在 litchClientTools.namespaces 里声明这些 */
  namespaces(): string[]
  has(namespace: string): boolean
}

/** 把答复送回收到这一份的那条连接。连接已经不在了返回 false */
export type DeviceToolReply = (response: ClientToolCallResponse) => boolean

interface Running {
  harness: string
  turnId: string
  controller: AbortController
  /** 收到的每一份各自的回法，按到达的先后 */
  replies: DeviceToolReply[]
}

/** 记着“已经答过”的调用最多这么多个（迟到的副本丢掉用）；回合结束时清，这里只防漏清 */
const DONE_LIMIT = 10_000

const sep = '\u0000'
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class DeviceTools implements DeviceToolRegistry {
  private readonly handlers = new Map<string, DeviceToolHandler>()
  /** 正在执行的调用。键：harness + 会话 + callId */
  private readonly running = new Map<string, Running>()
  /** 已经答过的调用到它的回合。之后再到的副本（原生 codex 恢复会话时补发的）直接丢掉；回合结束时清 */
  private readonly done = new Map<string, { harness: string; turnId: string }>()
  private closed = false
  private readonly log: (line: string) => void

  constructor(log: (line: string) => void = () => {}) {
    this.log = log
  }

  register(namespace: string, handler: DeviceToolHandler): void {
    if (!namespace.startsWith(CLIENT_TOOL_NAMESPACE_PREFIX))
      throw new Error(`设备工具的命名空间要以 ${CLIENT_TOOL_NAMESPACE_PREFIX} 开头：${namespace}`)
    if (this.handlers.has(namespace)) throw new Error(`设备工具 ${namespace} 已经注册过了`)
    this.handlers.set(namespace, handler)
  }

  namespaces(): string[] {
    return [...this.handlers.keys()]
  }

  has(namespace: unknown): boolean {
    return typeof namespace === 'string' && this.handlers.has(namespace)
  }

  /**
   * 一份 item/tool/call 到了（params 是请求的参数）。同一次调用（harness + 会话 + callId）的几份只执行一次：
   * 已经在执行的把这一份的回法记上，执行完从最先到的、还连着的那份回；已经答过的直接丢掉。
   * 没注册的命名空间当场回 invalid
   */
  dispatch(harness: string, params: Record<string, unknown>, reply: DeviceToolReply): void {
    const call: DeviceToolCall = {
      harness,
      threadId: text(params.threadId),
      turnId: text(params.turnId),
      callId: text(params.callId),
      namespace: text(params.namespace),
      tool: text(params.tool),
      arguments: params.arguments,
    }
    const handler = this.handlers.get(call.namespace)
    if (!handler) {
      reply(clientToolFailure('invalid', `${call.namespace} is not available on this device.`))
      return
    }
    const key = [harness, call.threadId, call.callId].join(sep)
    if (this.done.has(key)) return
    const running = this.running.get(key)
    if (running) {
      running.replies.push(reply)
      return
    }
    const entry: Running = {
      harness,
      turnId: call.turnId,
      controller: new AbortController(),
      replies: [reply],
    }
    if (this.closed) entry.controller.abort(new Error('设备进程关了'))
    this.running.set(key, entry)
    const finish = (response: ClientToolCallResponse) => {
      this.running.delete(key)
      if (this.done.size >= DONE_LIMIT) this.done.clear()
      this.done.set(key, { harness, turnId: call.turnId })
      if (!entry.replies.some((send) => send(response)))
        this.log(
          `${harness} 的 ${call.namespace}.${call.tool}（会话 ${call.threadId}）答不回去了：连接都断了`,
        )
    }
    // 处理函数同步抛的也按失败答
    Promise.resolve()
      .then(() => handler(call, { signal: entry.controller.signal }))
      .then(finish, (error: unknown) => {
        this.log(`设备工具 ${call.namespace}.${call.tool} 出错：${message(error)}`)
        finish(
          clientToolFailure('failed', `${call.namespace}.${call.tool} failed: ${message(error)}`),
        )
      })
  }

  /** 一个回合结束了：它里面还在执行的调用作废（signal），记着的“已答过”清掉 */
  turnEnded(harness: string, turnId: string): void {
    for (const entry of this.running.values())
      if (entry.harness === harness && entry.turnId === turnId)
        entry.controller.abort(new Error('回合结束了'))
    for (const [key, entry] of this.done)
      if (entry.harness === harness && entry.turnId === turnId) this.done.delete(key)
  }

  /** 设备进程关了：还在跑的处理函数收到取消 */
  close(): void {
    this.closed = true
    for (const entry of this.running.values()) entry.controller.abort(new Error('设备进程关了'))
  }
}

/**
 * 设备进程替自己通往引擎的连接声明能执行这些命名空间：litchExtensions 里加上 clientTools，
 * litchClientTools.namespaces 里加上它们。客户端自己的声明照原样保留（它声明了别的命名空间的照旧）。
 * 原生 codex 不认识这两个键，它的“话”在握手前会摘掉（native-codex.mts），由设备进程自己拦它的调用。
 */
export function declareDeviceTools(given: unknown, namespaces: readonly string[]): unknown {
  if (namespaces.length === 0) return given
  const fields = isObject(given) ? given : {}
  const capabilities = isObject(fields.capabilities) ? fields.capabilities : {}
  const listed = capabilities[EXTENSIONS_CAPABILITY]
  const extensions = Array.isArray(listed) ? [...listed] : []
  if (!extensions.includes(EXTENSION.clientTools)) extensions.push(EXTENSION.clientTools)
  const declared = capabilities[CLIENT_TOOLS_CAPABILITY]
  const tools = isObject(declared) ? declared : {}
  // 客户端没声明 clientTools 扩展时，它列的命名空间本来不算数，加上扩展之后也不能让它们算数
  const own: unknown[] =
    Array.isArray(listed) &&
    listed.includes(EXTENSION.clientTools) &&
    Array.isArray(tools.namespaces)
      ? tools.namespaces
      : []
  const added = namespaces.filter((namespace) => !own.includes(namespace))
  return {
    ...fields,
    capabilities: {
      ...capabilities,
      [EXTENSIONS_CAPABILITY]: extensions,
      [CLIENT_TOOLS_CAPABILITY]: { ...tools, namespaces: [...own, ...added] },
    },
  }
}
