// 一台设备上的客户端工具调用（扩展 clientTools，设计文档 05 第三、九节）：
// 引擎要这台桌面端执行 litch_ 开头的命名空间里的工具时发来 `item/tool/call`。这里管：
// - 认不认：别的命名空间照旧回“方法不存在”；这台桌面执行不了的命名空间当场回 noExecutor；
// - 设备的开关（决 190：浏览器默认开、Computer Use 默认关），关着当场回 disabled，说明写给模型；
// - 交给主进程执行（经 ToolHub），带上设备、harness、工作目录；
// - 执行器要用户点头时在这个会话的对话里出卡片（经 host.showAsk），答了回给主进程；
// - 超时（等人答卡片的时间不算）、引擎撤回请求、回合结束或被打断、连接断开时取消，并告诉主进程；
// - 执行过工具调用的回合结束时告诉主进程（turnEnded），执行器收拾临时的东西。
// 会话在核心里有没有开着视图都要处理：回合在后台跑的时候引擎照样会调。
import {
  CLIENT_TOOL_NAMESPACE,
  type ClientToolCallParams,
  type ClientToolCallResponse,
  clientToolFailure,
  isClientToolNamespace,
} from '../../../protocol/src/client-tools.mjs'
import type { JsonRpcId } from '../../../protocol/src/index.mjs'
import type { Clock } from '../channel/protocol.mjs'
import { NO_REPLY } from '../connection/rpc.mjs'
import type { ApprovalOption, ClientAskView } from '../model.mjs'
import type { ToolAnswer, ToolInvocation } from '../model-client-tools.mjs'
import type { ToolHub } from '../tool-hub.mjs'

/** 一次调用最多等多久。等人答卡片的那一段不算（卡片挂着的时候停表，答了从头算） */
export const CALL_TIMEOUT_MS = 120_000

/** 要用户点头的一次：出卡片要知道的 */
export interface ToolAskPlace {
  threadId: string
  turnId: string
  callId: string
  askId: string
  namespace: string
  tool: string
  ask: ClientAskView
}

export interface ToolCallsHost {
  deviceId: string
  clock: Clock
  hub: ToolHub
  /** 调用来自哪台设备，交给执行器（远程设备的 Computer Use 没有“始终允许”，执行器按 kind 判断） */
  device(): ToolInvocation['device']
  /** 这台设备的开关里这个命名空间开着没有。没有开关的命名空间（测试用的 echo）一律算开着 */
  allowed(namespace: string): boolean
  /** 这个会话属于哪个 harness、工作目录在哪。不知道的是 null */
  context(threadId: string): { harness: string | null; cwd: string | null }
  /**
   * 在这个会话的对话里出一张卡片。用户答了、或者卡片被撤了（回合结束、连接断开，这时是 null）调 answer；
   * 返回的函数是“不用了”：撤掉卡片，不再调 answer
   */
  showAsk(place: ToolAskPlace, answer: (answer: ToolAnswer | null) => void): () => void
  log(line: string): void
}

export interface ToolCalls {
  /** 不是 item/tool/call、不是 litch_ 的命名空间返回 undefined：照旧回“方法不存在” */
  serverRequest(method: string, params: unknown, id: JsonRpcId): Promise<unknown> | undefined
  /** 引擎说这个请求有了结果（别处答了、作废了）：不等了 */
  resolved(requestId: string): void
  /** 用户在这边打断了这个会话的回合：正在执行的调用当场取消 */
  interrupted(threadId: string): void
  /** 回合结束了（完成、打断、出错都算） */
  turnEnded(threadId: string, turnId: string): void
  /** 连接断了：都不等了，执行过调用的回合一并当作结束 */
  offline(): void
}

interface Running {
  id: string
  rpcId: string
  threadId: string
  turnId: string
  resolve(result: ClientToolCallResponse | typeof NO_REPLY): void
  /** 超时的定时器：取消函数。卡片挂着的时候停表，是 null */
  stopTimer: (() => void) | null
  /** 挂着的卡片：卡片的标识 → 撤掉它 */
  asks: Map<string, () => void>
}

/** 设备开关关着时给模型的话：告诉它让用户去哪里打开 */
const DISABLED: Record<string, string> = {
  [CLIENT_TOOL_NAMESPACE.browser]:
    'The built-in browser is turned off for this device in Litch. Ask the user to turn on "Built-in browser" in Litch (Devices → this device), then try again.',
  [CLIENT_TOOL_NAMESPACE.computer]:
    'Computer Use is turned off for this device in Litch. Ask the user to turn on "Computer Use" in Litch (Devices → this device), then try again.',
}

/**
 * 卡片上的选项（决 190、05 第 3.2、3.3 节）：网站是“这一次 / 这个会话 / 一直 / 拒绝”；
 * 应用是“这个会话 / 始终 / 拒绝”，执行器说不许“始终”（远程设备）时没有那一项
 */
export const clientAskOptions = (ask: ClientAskView): ApprovalOption[] =>
  ask.kind === 'machine'
    ? // 远程设备操作本机（08 号 3.2）：没有“始终允许”
      [
        { id: 'once', role: 'accept' },
        { id: 'session', role: 'acceptSession' },
        { id: 'decline', role: 'decline' },
      ]
    : ask.kind === 'site'
      ? [
          { id: 'once', role: 'accept' },
          { id: 'session', role: 'acceptSession' },
          { id: 'always', role: 'acceptAlways' },
          { id: 'decline', role: 'decline' },
        ]
      : [
          { id: 'session', role: 'acceptSession' },
          ...(ask.allowAlways ? [{ id: 'always', role: 'acceptAlways' } as const] : []),
          { id: 'decline', role: 'decline' },
        ]

const turnKey = (threadId: string, turnId: string) => `${threadId}\u0000${turnId}`

export function createToolCalls(host: ToolCallsHost): ToolCalls {
  const running = new Map<string, Running>()
  /** 这台设备上执行过工具调用、还没结束的回合 */
  const turns = new Map<string, { threadId: string; turnId: string }>()
  let seq = 0

  const finish = (call: Running, result: ClientToolCallResponse | typeof NO_REPLY) => {
    if (running.get(call.id) !== call) return
    running.delete(call.id)
    call.stopTimer?.()
    call.stopTimer = null
    for (const drop of call.asks.values()) drop()
    call.asks.clear()
    call.resolve(result)
  }

  /** 不等了：告诉主进程取消，给引擎回这一句 */
  const abandon = (call: Running, result: ClientToolCallResponse | typeof NO_REPLY) => {
    host.hub.cancel(call.id)
    finish(call, result)
  }

  const startTimer = (call: Running) => {
    call.stopTimer?.()
    call.stopTimer = host.clock.setTimer(() => {
      call.stopTimer = null
      host.log(`客户端工具调用 ${call.id} 超时`)
      abandon(
        call,
        clientToolFailure(
          'failed',
          `The desktop did not finish this tool call within ${CALL_TIMEOUT_MS / 1000} seconds.`,
        ),
      )
    }, CALL_TIMEOUT_MS)
  }

  const call = (params: ClientToolCallParams, rpcId: string): Promise<unknown> => {
    const namespace = params.namespace ?? ''
    if (!host.hub.namespaces().includes(namespace)) {
      return Promise.resolve(
        clientToolFailure(
          'noExecutor',
          `The connected Litch desktop cannot run ${namespace} tools.`,
        ),
      )
    }
    if (!host.allowed(namespace)) {
      return Promise.resolve(
        clientToolFailure(
          'disabled',
          DISABLED[namespace] ??
            `${namespace} is turned off for this device in Litch. Ask the user to turn it on in Litch (Devices → this device).`,
        ),
      )
    }
    const id = `${host.deviceId}:${++seq}`
    const { harness, cwd } = host.context(params.threadId)
    const invocation: ToolInvocation = {
      threadId: params.threadId,
      turnId: params.turnId,
      callId: params.callId,
      namespace,
      tool: params.tool,
      arguments: params.arguments,
      id,
      device: host.device(),
      harness,
      cwd,
    }
    turns.set(turnKey(params.threadId, params.turnId), {
      threadId: params.threadId,
      turnId: params.turnId,
    })
    return new Promise<unknown>((resolve) => {
      const entry: Running = {
        id,
        rpcId,
        threadId: params.threadId,
        turnId: params.turnId,
        resolve,
        stopTimer: null,
        asks: new Map(),
      }
      running.set(id, entry)
      startTimer(entry)
      host.hub.call(invocation, {
        result: (response) => finish(entry, response),
        ask(askId, ask) {
          if (running.get(id) !== entry) return
          // 等人答的时候不计时
          entry.stopTimer?.()
          entry.stopTimer = null
          const place: ToolAskPlace = {
            threadId: params.threadId,
            turnId: params.turnId,
            callId: params.callId,
            askId,
            namespace,
            tool: params.tool,
            ask,
          }
          const drop = host.showAsk(place, (answer) => {
            entry.asks.delete(askId)
            host.hub.answer(askId, answer)
            if (running.get(id) === entry && entry.asks.size === 0) startTimer(entry)
          })
          entry.asks.set(askId, drop)
        },
        askDone(askId) {
          const drop = entry.asks.get(askId)
          if (!drop) return
          entry.asks.delete(askId)
          drop()
          if (running.get(id) === entry && entry.asks.size === 0) startTimer(entry)
        },
      })
    })
  }

  return {
    serverRequest(method, params, id) {
      if (method !== 'item/tool/call') return undefined
      const raw = params as Partial<ClientToolCallParams> | null
      if (
        !raw ||
        typeof raw.threadId !== 'string' ||
        typeof raw.turnId !== 'string' ||
        typeof raw.callId !== 'string' ||
        typeof raw.tool !== 'string' ||
        !isClientToolNamespace(raw.namespace)
      ) {
        return undefined
      }
      return call(raw as ClientToolCallParams, String(id))
    },

    resolved(requestId) {
      for (const entry of [...running.values()]) {
        if (entry.rpcId === requestId) abandon(entry, NO_REPLY)
      }
    },

    interrupted(threadId) {
      for (const entry of [...running.values()]) {
        if (entry.threadId !== threadId) continue
        abandon(entry, clientToolFailure('failed', 'The user interrupted this turn.'))
      }
    },

    turnEnded(threadId, turnId) {
      for (const entry of [...running.values()]) {
        if (entry.threadId !== threadId || entry.turnId !== turnId) continue
        abandon(entry, clientToolFailure('failed', 'The turn ended before the tool finished.'))
      }
      const key = turnKey(threadId, turnId)
      if (!turns.delete(key)) return
      host.hub.turnEnded(host.deviceId, threadId, turnId)
    },

    offline() {
      // 连接已经没了，回什么对面都收不到
      for (const entry of [...running.values()]) abandon(entry, NO_REPLY)
      for (const { threadId, turnId } of turns.values()) {
        host.hub.turnEnded(host.deviceId, threadId, turnId)
      }
      turns.clear()
    },
  }
}
