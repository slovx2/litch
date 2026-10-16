// 主进程里客户端工具的那一头：收核心经工具进程发来的调用，按命名空间交给登记的执行器（registry.mts），
// 结果、要用户点头的卡片发回核心。这是“主进程不在数据路径上”的一处例外（设计文档 05 第九节）：
// 浏览器视图、Computer Use 助手都只能由主进程管。经手的只有这一次调用的参数和结果，不碰会话内容。
// 超时、回合结束、连接断开都由核心判断，这里只照它说的取消（op: cancel），执行器从 signal 上知道。
import {
  type ClientToolCallResponse,
  clientToolFailure,
} from '../../../../packages/protocol/src/client-tools.mjs'
import {
  CLIENT_TOOL,
  type ClientToolAnswer,
  type ClientToolAsk,
  type ClientToolContext,
  type ClientToolExecutor,
  type ClientToolToCore,
  type ClientToolToMain,
} from './types.mjs'

export interface ClientToolHost {
  /** 能执行的命名空间：登记了执行器的那几个。启动时报给核心，核心握手时照它声明 */
  namespaces(): string[]
  /**
   * 再登记一个执行器。要等应用就绪才建得出来的（内置浏览器）用它，必须在核心启动之前登记，
   * 否则这一次握手没有声明它
   */
  add(executor: ClientToolExecutor): void
  /** 核心发来的一条消息 */
  handle(message: ClientToolToMain): void
  /** 核心没了（退出、重启）：手上的调用都中止，卡片都当作没答 */
  reset(): void
}

interface Running {
  controller: AbortController
  /** 这次调用挂着的卡片 */
  asks: Set<string>
}

export function createClientToolHost(
  executors: readonly ClientToolExecutor[],
  post: (message: ClientToolToCore) => void,
  log: (line: string) => void = (line) => console.error(`[client-tools] ${line}`),
): ClientToolHost {
  const byNamespace = new Map<string, ClientToolExecutor>()
  const add = (executor: ClientToolExecutor) => {
    if (byNamespace.has(executor.namespace)) {
      log(`命名空间 ${executor.namespace} 登记了两个执行器，只用头一个`)
      return
    }
    byNamespace.set(executor.namespace, executor)
  }
  for (const executor of executors) add(executor)
  const running = new Map<string, Running>()
  /** 等用户答的卡片：卡片的标识 → 答了（或者撤了，null）之后怎么办 */
  const waiting = new Map<string, (answer: ClientToolAnswer | null) => void>()
  let askSeq = 0

  const settleAsk = (askId: string, answer: ClientToolAnswer | null) => {
    const resolve = waiting.get(askId)
    if (!resolve) return
    waiting.delete(askId)
    resolve(answer)
  }

  /** 这次调用挂着的卡片都不用了：撤掉（告诉核心），执行器那边当作没答 */
  const dropAsks = (entry: Running, tell: boolean) => {
    for (const askId of [...entry.asks]) {
      if (tell) post({ type: CLIENT_TOOL, op: 'askDone', askId })
      settleAsk(askId, null)
    }
    entry.asks.clear()
  }

  const run = async (executor: ClientToolExecutor, message: ClientToolToMain & { op: 'call' }) => {
    const { invocation } = message
    const { id } = invocation
    const entry: Running = { controller: new AbortController(), asks: new Set() }
    running.set(id, entry)
    const { signal } = entry.controller
    const context: ClientToolContext = {
      signal,
      ask(ask: ClientToolAsk) {
        if (signal.aborted || running.get(id) !== entry) return Promise.resolve(null)
        const askId = `${id}#${++askSeq}`
        entry.asks.add(askId)
        return new Promise<ClientToolAnswer | null>((resolve) => {
          waiting.set(askId, (answer) => {
            entry.asks.delete(askId)
            resolve(answer)
          })
          post({ type: CLIENT_TOOL, op: 'ask', id, askId, ask })
        })
      },
    }
    let response: ClientToolCallResponse
    try {
      response = await executor.call(invocation, context)
    } catch (error) {
      // 执行器说好了不抛错；抛了也不能让模型干等
      log(`执行器 ${executor.namespace} 出错：${String(error)}`)
      response = clientToolFailure(
        'failed',
        `The desktop failed to run this tool: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    // 已经被取消了：核心不等这一次了，结果不用回
    if (running.get(id) !== entry) return
    running.delete(id)
    dropAsks(entry, true)
    post({ type: CLIENT_TOOL, op: 'result', id, response })
  }

  return {
    namespaces: () => [...byNamespace.keys()],
    add,

    handle(message) {
      if (message?.type !== CLIENT_TOOL) return
      switch (message.op) {
        case 'call': {
          const namespace = message.invocation.namespace ?? ''
          const executor = byNamespace.get(namespace)
          if (!executor) {
            post({
              type: CLIENT_TOOL,
              op: 'result',
              id: message.invocation.id,
              response: clientToolFailure(
                'noExecutor',
                `The connected Litch desktop cannot run ${namespace} tools.`,
              ),
            })
            return
          }
          void run(executor, message)
          return
        }
        case 'cancel': {
          const entry = running.get(message.id)
          if (!entry) return
          running.delete(message.id)
          // 核心那边的卡片已经撤了，不用再说
          dropAsks(entry, false)
          entry.controller.abort()
          return
        }
        case 'answer':
          settleAsk(message.askId, message.answer)
          return
        case 'turnEnded':
          for (const executor of byNamespace.values()) {
            try {
              executor.turnEnded?.({
                deviceId: message.deviceId,
                threadId: message.threadId,
                turnId: message.turnId,
              })
            } catch (error) {
              log(`执行器 ${executor.namespace} 收尾出错：${String(error)}`)
            }
          }
          return
      }
    },

    reset() {
      for (const entry of running.values()) {
        dropAsks(entry, false)
        entry.controller.abort()
      }
      running.clear()
      for (const askId of [...waiting.keys()]) settleAsk(askId, null)
    },
  }
}
