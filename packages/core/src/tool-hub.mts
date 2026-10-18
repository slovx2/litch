// 核心里通往主进程的那一头（客户端工具）：各台设备收到的工具调用都经它交给主进程，主进程的回话按调用的标识
// 分回给发起的那一台。它只管收发和对号，开关、超时、卡片、回合收尾都是设备那一层的事（device/tool-calls.mts）。
import type { ClientToolCallResponse } from '../../protocol/src/client-tools.mjs'
import type { ClientAskView } from './model.mjs'
import {
  CLIENT_TOOL,
  type ClientToolPort,
  type ToolAnswer,
  type ToolInvocation,
  type ToolToCore,
} from './model-client-tools.mjs'

/** 一次调用在执行途中主进程报回来的事 */
export interface ToolCallHandlers {
  result(response: ClientToolCallResponse): void
  /** 执行器要用户点头：出一张卡片 */
  ask(askId: string, ask: ClientAskView): void
  /** 那张卡片不用了（执行器不等了）：撤掉，不用回 */
  askDone(askId: string): void
}

export interface ToolHub {
  /** 这台桌面能执行的命名空间。没有外壳（测试、模拟核心之外的纯核心）时是空的 */
  namespaces(): readonly string[]
  /** 执行工具的这台桌面的平台（process.platform），不知道是 null */
  platform?(): string | null
  /** 交给主进程执行。之后的回话经 handlers 报回来，直到结果到了或者 cancel */
  call(invocation: ToolInvocation, handlers: ToolCallHandlers): void
  /** 不等了（超时、回合结束、连接断了）：告诉主进程，之后它再报这一次调用的事都不理 */
  cancel(id: string): void
  /** 卡片答了，或者被撤了（null） */
  answer(askId: string, answer: ToolAnswer | null): void
  /** 一个执行过工具调用的回合结束了：执行器收拾这个回合留下的临时东西 */
  turnEnded(deviceId: string, threadId: string, turnId: string): void
}

export function createToolHub(
  port: ClientToolPort | undefined,
  log: (line: string) => void,
): ToolHub {
  const calls = new Map<string, ToolCallHandlers>()
  /** 卡片的标识 → 哪一次调用的 */
  const asks = new Map<string, string>()

  const receive = (message: ToolToCore) => {
    if (message?.type !== CLIENT_TOOL) return
    switch (message.op) {
      case 'result': {
        const handlers = calls.get(message.id)
        if (!handlers) return
        calls.delete(message.id)
        for (const [askId, id] of asks) if (id === message.id) asks.delete(askId)
        handlers.result(message.response)
        return
      }
      case 'ask': {
        const handlers = calls.get(message.id)
        // 已经不等这一次了：卡片不出，当作没答就撤了
        if (!handlers) {
          port?.post({ type: CLIENT_TOOL, op: 'answer', askId: message.askId, answer: null })
          return
        }
        asks.set(message.askId, message.id)
        handlers.ask(message.askId, message.ask)
        return
      }
      case 'askDone': {
        const id = asks.get(message.askId)
        if (id === undefined) return
        asks.delete(message.askId)
        calls.get(id)?.askDone(message.askId)
        return
      }
      case 'namespaces':
        // 握手时用的那一份由外壳记着（ClientToolPort.namespaces），这里不用管
        return
      default:
        log(`主进程发来不认识的客户端工具消息：${String((message as { op?: unknown }).op)}`)
    }
  }
  port?.listen(receive)

  return {
    namespaces: () => port?.namespaces() ?? [],
    platform: () => port?.platform?.() ?? null,
    call(invocation, handlers) {
      if (!port) {
        handlers.result({
          success: false,
          contentItems: [{ type: 'inputText', text: '[litch:noExecutor] no desktop shell' }],
        })
        return
      }
      calls.set(invocation.id, handlers)
      port.post({ type: CLIENT_TOOL, op: 'call', invocation })
    },
    cancel(id) {
      if (!calls.delete(id)) return
      for (const [askId, owner] of asks) if (owner === id) asks.delete(askId)
      port?.post({ type: CLIENT_TOOL, op: 'cancel', id })
    },
    answer(askId, answer) {
      asks.delete(askId)
      port?.post({ type: CLIENT_TOOL, op: 'answer', askId, answer })
    },
    turnEnded(deviceId, threadId, turnId) {
      port?.post({ type: CLIENT_TOOL, op: 'turnEnded', deviceId, threadId, turnId })
    },
  }
}
