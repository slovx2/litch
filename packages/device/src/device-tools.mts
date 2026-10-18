// 由设备进程自己执行的 litch_ 命名空间（litch_tasks、会话树的 litch_sessions……）。
// 各模块把处理函数注册进来；调用从哪来都交到这里：
//   - 客户端连接对应的上游连接上，适配器的引擎发来的 item/tool/call（relay.mts 截下）；
//   - 原生 codex 那条路由（client-tools.mts），它把同一次调用发给每条订阅着会话的连接；
//   - 设备进程自己开的内部连接（engine-link.mts）。
// 设备进程替每条通往引擎的连接在握手里声明这些命名空间（declareDeviceTools），引擎挑执行方时挑得中它。
// 同一次调用（harness + 会话 + callId）只答第一份，其余几份不答：原生 codex 的答复从哪条连接回去都算数。
import {
  CLIENT_TOOL_NAMESPACE_PREFIX,
  CLIENT_TOOLS_CAPABILITY,
  type ClientToolCallResponse,
  clientToolFailure,
} from '../../protocol/src/client-tools.mjs'
import { EXTENSION, EXTENSIONS_CAPABILITY } from '../../protocol/src/device.mjs'
import { type Frame, isObject } from './wire.mjs'

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

/** 答过的调用记多久（毫秒）。原生 codex 的几份前后只差几毫秒，恢复会话时补发的也在回合之内 */
const REMEMBER_MS = 30 * 60 * 1000

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export class DeviceTools implements DeviceToolRegistry {
  private readonly handlers = new Map<string, DeviceToolHandler>()
  private readonly answered = new Map<string, number>()
  /** 设备进程关了：还在跑的处理函数收到取消 */
  private readonly lifetime = new AbortController()
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
   * 一份 item/tool/call 到了（frame 是上游发来的原样请求）。同一次调用的别的几份不答。
   * reply 把答复送回收到这一份的那条连接
   */
  dispatch(harness: string, frame: Frame, reply: (result: ClientToolCallResponse) => void): void {
    const params = isObject(frame.params) ? frame.params : {}
    const call: DeviceToolCall = {
      harness,
      threadId: text(params.threadId),
      turnId: text(params.turnId),
      callId: text(params.callId) || String(frame.id),
      namespace: text(params.namespace),
      tool: text(params.tool),
      arguments: params.arguments,
    }
    const key = [harness, call.threadId, call.callId].join('\u0000')
    const now = Date.now()
    for (const [old, at] of this.answered) if (now - at > REMEMBER_MS) this.answered.delete(old)
    if (this.answered.has(key)) return
    this.answered.set(key, now)
    const handler = this.handlers.get(call.namespace)
    if (!handler) {
      reply(clientToolFailure('invalid', `${call.namespace} is not available on this device.`))
      return
    }
    let work: Promise<ClientToolCallResponse>
    try {
      work = handler(call, { signal: this.lifetime.signal })
    } catch (error) {
      work = Promise.reject(error)
    }
    work.then(reply, (error) => {
      this.log(`设备工具 ${call.namespace}.${call.tool} 出错：${String(error)}`)
      reply(
        clientToolFailure(
          'failed',
          `${call.namespace}.${call.tool} failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
    })
  }

  close(): void {
    this.lifetime.abort(new Error('设备进程关了'))
  }
}

/**
 * 设备进程替自己通往引擎的连接声明能执行这些命名空间：litchExtensions 里加上 clientTools，
 * litchClientTools.namespaces 里加上它们。客户端自己的声明照原样保留（它声明了别的命名空间的照旧）。
 * 原生 codex 不认识这两个键，它的“话”在握手前会摘掉（native-codex.mts），由设备进程自己拦它的调用。
 */
export function declareDeviceTools(given: unknown, namespaces: readonly string[]): unknown {
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
