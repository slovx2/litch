// 一台设备上见过的引擎自己的子代理线程（parentThreadId、来历是由别的线程派出）。它们不进侧栏：
// 这里记下会话对象和各自最近的一个回合，答“这是不是子代理”，并给父会话一份带状态的子代理列表。
//
// 子代理的状态以子线程为准：它的回合开始、结束的通知不管子线程开没开着都会到（原生 codex 发给每条连接，
// 适配器的入口跟着父会话的订阅连接发），所以派出它的那个条目里的快照停在“在跑”也不要紧。
// 列表刚问来时（thread/list 不带回合）另向对面要每个子线程最近的一个回合（thread/turns/list）。
// 回合结束的通知只发给当时看着父会话的连接：那时没看着、断开过的，记着的回合会一直停在“在跑”，
// 而会话状态（广播给每条连接）已经不在跑了。对不上的交给 stale，由设备再问一次最近的回合。
import type { Thread, ThreadStatus, Turn } from '../../../protocol/src/index.mjs'
import type { AgentThreadView, AgentTurnView } from '../model-tree.mjs'
import { parentOf } from '../projection/session.mjs'
import { projectAgentThread, projectAgentTurn } from '../projection/tree.mjs'

export interface AgentThreads {
  has(threadId: string): boolean
  /** 记下（或换掉）一个子代理线程的会话对象。对象里不带回合的，之前记着的那个回合留着 */
  put(thread: Thread): void
  /** 会话对象上的几项变了（状态、名字……）。不认识的线程不管 */
  patch(threadId: string, patch: Partial<Thread>): void
  /** 子线程的一个回合开始了或者结束了（turn/started、turn/completed） */
  turn(threadId: string, turn: Turn): void
  /**
   * 问来的最近一个回合（thread/turns/list）。since 是发问之前 stamp() 给的：这之间通知已经报过新的，
   * 问来的就是旧的，不用
   */
  settle(threadId: string, turn: Turn, since: number): void
  /** 这个线程的回合信息现在是第几版 */
  stamp(threadId: string): number
  /** 记着最近一个回合了没有 */
  knowsTurn(threadId: string): boolean
  /** 记着的回合在跑，会话状态却不在跑：回合结束的通知没收到，记着的不可信 */
  stale(threadId: string): boolean
  /** 记着的回合在跑的子线程（重连之后要重问：断开那阵结束了的、引擎进程换了停在半路的都收不到通知） */
  running(): string[]
  forget(threadId: string): void
  /** 父会话的子代理，最近动过的在前 */
  list(parentId: string): AgentThreadView[]
}

/**
 * changed：这个父会话的子代理列表变了（谁、状态、回合）。
 * stale：会话对象换了或改了以后，这个子线程记着的回合对不上了（见 AgentThreads.stale）
 */
export function createAgentThreads(
  changed: (parentId: string) => void,
  stale: (threadId: string) => void = () => {},
): AgentThreads {
  const threads = new Map<string, Thread>()
  const turns = new Map<string, AgentTurnView>()
  const stamps = new Map<string, number>()
  let seq = 0

  const isStale = (threadId: string): boolean =>
    turns.get(threadId)?.state === 'running' && threads.get(threadId)?.status?.type !== 'active'

  const touch = (threadId: string) => {
    const thread = threads.get(threadId)
    const parent = thread ? parentOf(thread) : null
    if (parent) changed(parent)
  }

  const record = (threadId: string, view: AgentTurnView) => {
    turns.set(threadId, view)
    stamps.set(threadId, ++seq)
  }

  return {
    has: (threadId) => threads.has(threadId),

    put(thread) {
      const last = thread.turns?.at(-1)
      if (last) record(thread.id, projectAgentTurn(last))
      threads.set(thread.id, { ...thread, turns: [] })
      touch(thread.id)
      if (isStale(thread.id)) stale(thread.id)
    },

    patch(threadId, patch) {
      const thread = threads.get(threadId)
      if (!thread) return
      threads.set(threadId, { ...thread, ...patch, turns: [] })
      touch(threadId)
      if (isStale(threadId)) stale(threadId)
    },

    turn(threadId, turn) {
      if (!threads.has(threadId)) return
      record(threadId, projectAgentTurn(turn))
      // 回合开始、结束的时候对面不一定另发状态通知：状态跟着回合走，不留着上一刻的
      const thread = threads.get(threadId)
      if (thread) {
        const status: ThreadStatus =
          turn.status === 'inProgress' ? { type: 'active', activeFlags: [] } : { type: 'idle' }
        threads.set(threadId, { ...thread, status })
      }
      touch(threadId)
    },

    settle(threadId, turn, since) {
      if (!threads.has(threadId) || (stamps.get(threadId) ?? 0) !== since) return
      record(threadId, projectAgentTurn(turn))
      touch(threadId)
    },

    stamp: (threadId) => stamps.get(threadId) ?? 0,
    knowsTurn: (threadId) => turns.has(threadId),
    stale: isStale,
    running: () => [...turns].filter(([, view]) => view.state === 'running').map(([id]) => id),

    forget(threadId) {
      const thread = threads.get(threadId)
      threads.delete(threadId)
      turns.delete(threadId)
      stamps.delete(threadId)
      const parent = thread ? parentOf(thread) : null
      if (parent) changed(parent)
    },

    list(parentId) {
      return [...threads.values()]
        .filter((thread) => parentOf(thread) === parentId)
        .map((thread) => projectAgentThread(thread, turns.get(thread.id) ?? null))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },
  }
}
