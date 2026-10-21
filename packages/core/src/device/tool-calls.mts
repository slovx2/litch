// 一台设备上的客户端工具调用（扩展 clientTools）：
// 引擎要这台桌面端执行 litch_ 开头的命名空间里的工具时发来 `item/tool/call`。这里管：
// - 认不认：别的命名空间照旧回“方法不存在”；这台桌面执行不了的命名空间当场回 noExecutor；
// - 设备的开关（浏览器默认开、Computer Use 默认关），关着当场回 disabled，说明写给模型；
// - 交给主进程执行（经 ToolHub），带上设备、harness、工作目录；
// - 执行器要用户点头时在这个会话的对话里出卡片（经 host.showAsk），答了回给主进程；
// - 超时（等人答卡片的时间不算）、引擎撤回请求、回合结束或被打断、连接断开时取消，并告诉主进程；
// - 执行过工具调用的回合结束时告诉主进程（turnEnded），执行器收拾临时的东西。
// 会话在核心里有没有开着视图都要处理：回合在后台跑的时候引擎照样会调。
//
// litch_machine 不交给主进程：交给核心自己的接线那一层（host.machine，machine-wiring.mts），
// 开关、审批、卡片放哪都在那里。这里照样管超时（卡片挂着时停表）、撤回、打断、断线。它有两种来路：
// 回合里的 item/tool/call，和设备进程转来的命令行调用 litch/clientTool/call（不一定有会话和回合）。
import {
  CLIENT_TOOL_METHOD,
  CLIENT_TOOL_NAMESPACE,
  type ClientToolCallParams,
  type ClientToolCallResponse,
  type ClientToolDetachedCallParams,
  clientToolFailure,
  isClientToolNamespace,
} from '../../../protocol/src/client-tools.mjs'
import { CONFIG_NAMESPACE, CONFIG_TOOL } from '../../../protocol/src/client-tools-config.mjs'
import type { JsonRpcId } from '../../../protocol/src/index.mjs'
import { createCancel } from '../channel/cancel.mjs'
import type { AbortSignalLike, Clock } from '../channel/protocol.mjs'
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

/** litch_machine 的一次调用，交给接线那一层时带的 */
export interface MachineCallInput {
  /** 会话。命令行调用找不到会话时是 null */
  threadId: string | null
  /** 回合。命令行调用不一定知道，是 null */
  turnId: string | null
  /** 工具调用的标识（item/tool/call 的 callId，或者设备进程给的那个） */
  callId: string
  harness: string | null
  tool: string
  arguments: unknown
  /** 超时、撤回、打断、断线、开关关掉时中止 */
  signal: AbortSignalLike
  /** 有卡片挂着的时候调：停表（等人答不算在 120 秒里）。返回“卡片没了”，表从头算 */
  hold(): () => void
}

/**
 * litch_config 的一次调用（只有命令行来的 litch/clientTool/call，不进 dynamicTools）。交给核心的执行器（config/executor.mts）。
 * 不许抛错：出错也回 success:false 的答复
 */
export interface ConfigCallInput {
  threadId: string | null
  harness: string | null
  arguments: unknown
  /** 有确认卡挂着、在等长的事时调：停表。返回“不等了”，表从头算 */
  hold(): () => void
}

/** 接线那一层（machine-wiring.mts 经设备转过来的） */
export interface MachineCalls {
  /** 不许抛错：出错也回 success:false 的答复 */
  call(input: MachineCallInput): Promise<ClientToolCallResponse>
  /** 回合结束了：同一回合里被拒的记录不要了 */
  turnEnded(threadId: string, turnId: string): void
}

export interface ToolCallsHost {
  deviceId: string
  clock: Clock
  hub: ToolHub
  /** litch_machine 的调用交给它。不给就是这台桌面执行不了，回 noExecutor */
  machine?: MachineCalls
  /** litch_config 的调用交给它（只有本机设备有）。不给回 noExecutor */
  config?(input: ConfigCallInput): Promise<ClientToolCallResponse>
  /** 调用来自哪台设备，交给执行器（远程设备的 Computer Use 没有“始终允许”，执行器按 kind 判断） */
  device(): ToolInvocation['device']
  /**
   * 这台设备上这个 harness 的开关里这个命名空间开着没有（harness 不知道是 null，按设备一级）。
   * 没有开关的命名空间（测试用的 echo）一律算开着
   */
  allowed(namespace: string, harness: string | null): boolean
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
  /** litch_machine 的开关关掉了：进行中的调用都以这个答复结束，挂着的卡片撤掉 */
  stopMachine(response: ClientToolCallResponse): void
}

interface Running {
  id: string
  rpcId: string
  threadId: string | null
  turnId: string | null
  /** litch_machine 的调用（交给接线那一层，不经主进程） */
  machine: boolean
  resolve(result: ClientToolCallResponse | typeof NO_REPLY): void
  /** 不等了：告诉执行的那一方（主进程，或者中止 litch_machine 的信号） */
  stop(): void
  /** 超时的定时器：取消函数。卡片挂着的时候停表，是 null */
  stopTimer: (() => void) | null
  /** 挂着的卡片：卡片的标识 → 撤掉它 */
  asks: Map<string, () => void>
  /** litch_machine 那边挂着的卡片有几张（它自己管卡片，这里只停表） */
  holds: number
}

/** 设备开关关着时给模型的话：告诉它让用户去哪里打开 */
const DISABLED: Record<string, string> = {
  [CLIENT_TOOL_NAMESPACE.browser]:
    'The built-in browser is turned off for this harness on this device in Litch. Ask the user to turn on "Built-in browser" for it in Litch (Settings → Feature switches), then try again.',
  [CLIENT_TOOL_NAMESPACE.computer]:
    'Computer Use is turned off for this harness on this device in Litch. Ask the user to turn on "Computer Use" for it in Litch (Settings → Feature switches), then try again.',
}

/**
 * 卡片上的选项：网站是“这一次 / 这个会话 / 一直 / 拒绝”；
 * 应用是“这个会话 / 始终 / 拒绝”，执行器说不许“始终”（远程设备）时没有那一项
 */
export const clientAskOptions = (ask: ClientAskView): ApprovalOption[] =>
  ask.kind === 'machine'
    ? // 远程设备操作本机（08 号 3.2）：没有“始终允许”
      [
        { id: 'once', role: 'accept' },
        // “逐条确认”下的执行、写入每次都问，允许整个会话没有意义
        ...(ask.perCall ? [] : [{ id: 'session', role: 'acceptSession' } as const]),
        // 拒绝时可以附一句理由给模型
        { id: 'decline', role: 'decline', note: true },
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

  /** 不等了：告诉执行的那一方取消，给引擎回这一句 */
  const abandon = (call: Running, result: ClientToolCallResponse | typeof NO_REPLY) => {
    if (running.get(call.id) === call) call.stop()
    finish(call, result)
  }

  /** 卡片都答完了（或者撤了）：表从头算 */
  const resume = (call: Running) => {
    if (running.get(call.id) === call && call.asks.size === 0 && call.holds === 0) startTimer(call)
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
    // 按会话所在的 harness 查：建会话之后才关掉的，已经建好的会话下一次调用就挡住
    const { harness, cwd } = host.context(params.threadId)
    if (!host.allowed(namespace, harness)) {
      return Promise.resolve(
        clientToolFailure(
          'disabled',
          DISABLED[namespace] ??
            `${namespace} is turned off for this harness on this device in Litch. Ask the user to turn it on in Litch (Settings → Feature switches).`,
        ),
      )
    }
    const id = `${host.deviceId}:${++seq}`
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
        machine: false,
        resolve,
        stop: () => host.hub.cancel(id),
        stopTimer: null,
        asks: new Map(),
        holds: 0,
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
            resume(entry)
          })
          entry.asks.set(askId, drop)
        },
        askDone(askId) {
          const drop = entry.asks.get(askId)
          if (!drop) return
          entry.asks.delete(askId)
          drop()
          resume(entry)
        },
        hold(held) {
          if (running.get(id) !== entry) return
          if (held) {
            entry.holds++
            entry.stopTimer?.()
            entry.stopTimer = null
          } else if (entry.holds > 0) {
            entry.holds--
            resume(entry)
          }
        },
      })
    })
  }

  /**
   * 交给核心自己执行的调用（litch_machine、litch_config）：超时、撤回、打断、断线照样在这里管。
   * work 拿到中止信号和停表的口子
   */
  const coreCall = (
    meta: { threadId: string | null; turnId: string | null; machine: boolean; label: string },
    rpcId: string,
    work: (signal: AbortSignalLike, hold: () => () => void) => Promise<ClientToolCallResponse>,
  ): Promise<unknown> => {
    const id = `${host.deviceId}:${++seq}`
    const cancel = createCancel()
    return new Promise<unknown>((resolve) => {
      const entry: Running = {
        id,
        rpcId,
        threadId: meta.threadId,
        turnId: meta.turnId,
        machine: meta.machine,
        resolve,
        stop: () => cancel.abort(),
        stopTimer: null,
        asks: new Map(),
        holds: 0,
      }
      running.set(id, entry)
      startTimer(entry)
      const hold = () => {
        entry.holds++
        entry.stopTimer?.()
        entry.stopTimer = null
        let held = true
        return () => {
          if (!held) return
          held = false
          entry.holds--
          resume(entry)
        }
      }
      work(cancel.signal, hold).then(
        (response) => finish(entry, response),
        (error: unknown) => {
          host.log(`${meta.label} 调用 ${id} 出错：${String(error)}`)
          finish(entry, clientToolFailure('failed', 'The desktop failed to run this tool call.'))
        },
      )
    })
  }

  /** litch_machine：交给接线那一层。超时、撤回、打断、断线照样在这里管 */
  const machineCall = (
    input: Omit<MachineCallInput, 'signal' | 'hold'>,
    rpcId: string,
  ): Promise<unknown> => {
    const machine = host.machine
    if (!machine) {
      return Promise.resolve(
        clientToolFailure(
          'noExecutor',
          'The connected Litch desktop cannot run litch_machine tools for this device.',
        ),
      )
    }
    return coreCall(
      { threadId: input.threadId, turnId: input.turnId, machine: true, label: 'litch_machine' },
      rpcId,
      (signal, hold) => machine.call({ ...input, signal, hold }),
    )
  }

  /** litch_config：交给核心的执行器。本机设备才有；命令行调用不一定有会话 */
  const configCall = (
    raw: Partial<ClientToolDetachedCallParams>,
    rpcId: string,
  ): Promise<unknown> => {
    const config = host.config
    if (!config) {
      return Promise.resolve(
        clientToolFailure(
          'noExecutor',
          'This Litch desktop connection does not run litch config (only the local device does).',
        ),
      )
    }
    if (raw.tool !== CONFIG_TOOL) {
      return Promise.resolve(
        clientToolFailure('invalid', `litch_config has only the ${CONFIG_TOOL} tool.`),
      )
    }
    const threadId = raw.threadId ?? null
    const harness =
      typeof raw.harness === 'string'
        ? raw.harness
        : threadId
          ? host.context(threadId).harness
          : null
    return coreCall(
      { threadId, turnId: raw.turnId ?? null, machine: false, label: 'litch_config' },
      rpcId,
      (_signal, hold) => config({ threadId, harness, arguments: raw.arguments, hold }),
    )
  }

  /** 命令行调用（设备进程转来的 litch/clientTool/call）：litch_machine、litch_config */
  const detachedCall = (params: unknown, rpcId: string): Promise<unknown> => {
    const raw = params as Partial<ClientToolDetachedCallParams> | null
    const nullable = (value: unknown) => value === null || typeof value === 'string'
    if (
      !raw ||
      typeof raw.callId !== 'string' ||
      typeof raw.namespace !== 'string' ||
      typeof raw.tool !== 'string' ||
      !nullable(raw.threadId) ||
      !nullable(raw.turnId)
    ) {
      return Promise.resolve(clientToolFailure('invalid', 'Malformed litch/clientTool/call.'))
    }
    if (raw.namespace === CONFIG_NAMESPACE) return configCall(raw, rpcId)
    if (raw.namespace !== CLIENT_TOOL_NAMESPACE.machine) {
      return Promise.resolve(
        clientToolFailure(
          'noExecutor',
          `The Litch desktop runs only ${CLIENT_TOOL_NAMESPACE.machine} and ${CONFIG_NAMESPACE} tools from the command line.`,
        ),
      )
    }
    const threadId = raw.threadId ?? null
    const harness =
      typeof raw.harness === 'string'
        ? raw.harness
        : threadId
          ? host.context(threadId).harness
          : null
    return machineCall(
      {
        threadId,
        turnId: raw.turnId ?? null,
        callId: raw.callId,
        harness,
        tool: raw.tool,
        arguments: raw.arguments,
      },
      rpcId,
    )
  }

  return {
    serverRequest(method, params, id) {
      if (method === CLIENT_TOOL_METHOD.call) return detachedCall(params, String(id))
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
      if (raw.namespace === CLIENT_TOOL_NAMESPACE.machine) {
        return machineCall(
          {
            threadId: raw.threadId,
            turnId: raw.turnId,
            callId: raw.callId,
            harness: host.context(raw.threadId).harness,
            tool: raw.tool,
            arguments: raw.arguments,
          },
          String(id),
        )
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
      host.machine?.turnEnded(threadId, turnId)
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

    stopMachine(response) {
      for (const entry of [...running.values()]) if (entry.machine) abandon(entry, response)
    },
  }
}
