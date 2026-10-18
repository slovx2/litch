// 【桩】这一份是丁线（会话树）在定时任务线的正式版合进 main 之前放的桩，照 11-scheduled-tasks.md“四之一”的签名写。
// 合并时删掉，换成定时任务线写的那份；本文件里多出来的东西（见下文“多给了”）要先跟它对齐。
//
// 由设备进程自己执行的 litch_ 命名空间（litch_sessions、litch_tasks）。这类工具的执行方不是桌面端，
// 是设备进程：会话、任务都在设备上。按命名空间注册处理函数，调用到了设备进程就在这里答，不转给任何客户端。
//
// 调用从哪来：
//   - 适配器的入口（claude-code、pi、dsh、opencode）按 clientTools 的规矩挑执行方。设备进程在转给它们的握手里
//     替每条上游连接声明这些命名空间（declareDeviceTools），调用于是落在某条上游连接上（发起回合的那条，
//     或者最早订阅的那条），relay.mts 在那里拦下交到这里；
//   - 原生 codex 不认识这项扩展，把同一个调用（请求号相同）发给订阅着会话的每条连接，答复从哪条回都算数。
//     这里按 harness + 会话 + callId 并成一次，只执行一次，答复从最先到的那份所在的连接回（它断了就换下一份）；
//   - 设备进程自己开的引擎连接（engine-link.mts）收到的也交到这里。
// 处理函数抛错时替它回 failed；回合结束（turn/completed）时它拿到的 signal 作废（wait 这种会等的工具要看它）。
//
// 和定时任务线约定的接口（design/harness-client/11-scheduled-tasks.md“四之一”）：DeviceToolCall、
// DeviceToolHandler、DeviceToolRegistry 的名字和形状不改。多给了：实现类 DeviceTools 的 dispatch、turnEnded、close，
// 和 declareDeviceTools（会话树要用，合并时请定时任务线的那份提供同样的东西）。
import {
  CLIENT_TOOLS_CAPABILITY,
  type ClientToolCallResponse,
  clientToolFailure,
  isClientToolNamespace,
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

/** 处理函数。返回的就是 item/tool/call 的答复；抛错时注册表替它回失败 */
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

export class DeviceTools implements DeviceToolRegistry {
  private readonly handlers = new Map<string, DeviceToolHandler>()
  /** 正在执行的调用。键：harness + 会话 + callId */
  private readonly running = new Map<string, Running>()
  /** 已经答过的调用到它的回合。之后再到的副本（原生 codex 恢复会话时补发的）直接丢掉 */
  private readonly done = new Map<string, { harness: string; turnId: string }>()
  private readonly log: (line: string) => void

  constructor(log: (line: string) => void = () => {}) {
    this.log = log
  }

  register(namespace: string, handler: DeviceToolHandler): void {
    if (!isClientToolNamespace(namespace))
      throw new Error(`设备执行的命名空间必须以 litch_ 开头：${namespace}`)
    if (this.handlers.has(namespace)) throw new Error(`${namespace} 已经注册过了`)
    this.handlers.set(namespace, handler)
  }

  namespaces(): string[] {
    return [...this.handlers.keys()]
  }

  has(namespace: unknown): boolean {
    return typeof namespace === 'string' && this.handlers.has(namespace)
  }

  /**
   * 一份 item/tool/call 到了（params 是请求的参数，命名空间已经注册过）。同一次调用的几份只执行一次：
   * 已经在执行的把这一份的回法记上，执行完从最先到的、还连着的那份回；已经答过的直接丢掉。
   */
  dispatch(harness: string, params: Record<string, unknown>, reply: DeviceToolReply): void {
    const call: DeviceToolCall = {
      harness,
      threadId: typeof params.threadId === 'string' ? params.threadId : '',
      turnId: typeof params.turnId === 'string' ? params.turnId : '',
      callId: typeof params.callId === 'string' ? params.callId : '',
      namespace: String(params.namespace),
      tool: typeof params.tool === 'string' ? params.tool : '',
      arguments: params.arguments,
    }
    const key = [harness, call.threadId, call.callId].join(sep)
    if (this.done.has(key)) return
    const running = this.running.get(key)
    if (running) {
      running.replies.push(reply)
      return
    }
    const handler = this.handlers.get(call.namespace)
    if (!handler) return
    const entry: Running = {
      harness,
      turnId: call.turnId,
      controller: new AbortController(),
      replies: [reply],
    }
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
      .then(finish, (error: unknown) =>
        finish(
          clientToolFailure(
            'failed',
            `设备进程执行 ${call.namespace}.${call.tool} 时出错：${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
      )
  }

  /** 一个回合结束了：它里面还在执行的调用作废（signal），记着的“已答过”清掉 */
  turnEnded(harness: string, turnId: string): void {
    for (const entry of this.running.values())
      if (entry.harness === harness && entry.turnId === turnId) entry.controller.abort()
    for (const [key, entry] of this.done)
      if (entry.harness === harness && entry.turnId === turnId) this.done.delete(key)
  }

  close(): void {
    for (const entry of this.running.values()) entry.controller.abort()
  }
}

/**
 * 设备进程替自己通往引擎的连接声明能执行这些命名空间：litchExtensions 里加上 clientTools，
 * litchClientTools.namespaces 里加上它们。客户端自己的声明照原样保留；客户端没声明 clientTools 扩展时，
 * 它列的命名空间本来不算数，加上扩展之后也不能让它们算数。
 * 原生 codex 不认识这两个键，它的“话”在握手前会摘掉（native-codex.mts），它的调用由设备进程在路由层拦。
 */
export function declareDeviceTools(given: unknown, namespaces: readonly string[]): unknown {
  if (namespaces.length === 0) return given
  const fields = isObject(given) ? given : {}
  const capabilities = isObject(fields.capabilities) ? fields.capabilities : {}
  const listed = Array.isArray(capabilities[EXTENSIONS_CAPABILITY])
    ? (capabilities[EXTENSIONS_CAPABILITY] as unknown[])
    : []
  const declared = listed.includes(EXTENSION.clientTools)
  const tools = isObject(capabilities[CLIENT_TOOLS_CAPABILITY])
    ? (capabilities[CLIENT_TOOLS_CAPABILITY] as Record<string, unknown>)
    : {}
  const own = declared && Array.isArray(tools.namespaces) ? tools.namespaces : []
  return {
    ...fields,
    capabilities: {
      ...capabilities,
      [EXTENSIONS_CAPABILITY]: declared ? listed : [...listed, EXTENSION.clientTools],
      [CLIENT_TOOLS_CAPABILITY]: {
        ...tools,
        namespaces: [...new Set([...own, ...namespaces])],
      },
    },
  }
}
