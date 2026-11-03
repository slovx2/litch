// 通知只需最近一回合的回答。未打开的会话也接住生命周期正文，避免为通知重读整段历史。
import type { ThreadItem, Turn } from '../../../protocol/src/index.mjs'
import type { TurnNotice } from '../../../protocol/src/turn-notices.mjs'
import type { Clock } from '../channel/protocol.mjs'
import type { SessionPeek } from '../model.mjs'
import { peekOf } from '../projection/peek.mjs'
import { projectTurn } from '../projection/session.mjs'

interface Entry {
  turnId: string
  itemId: string | null
  peek: SessionPeek
  complete: boolean
}

export function createPeekCache() {
  const entries = new Map<string, Entry>()
  const listeners = new Map<string, Set<(peek: SessionPeek) => void>>()
  const received = new Set<string>()
  const start = (threadId: string, turnId: string): Entry => {
    let entry = entries.get(threadId)
    if (entry?.turnId === turnId) return entry
    entry = {
      turnId,
      itemId: null,
      peek: { answer: null, error: null, pending: null },
      complete: false,
    }
    entries.delete(threadId)
    entries.set(threadId, entry)
    // 不给每个历史会话常驻一份正文；被淘汰的仍可按需读取历史。
    const oldest = entries.keys().next().value
    if (entries.size > 100 && oldest) entries.delete(oldest)
    return entry
  }
  const ready = (threadId: string): SessionPeek | null => {
    const entry = entries.get(threadId)
    return entry?.complete ? entry.peek : null
  }
  return {
    forget: (threadId: string) => entries.delete(threadId),
    clear: () => entries.clear(),
    receive(notice: TurnNotice) {
      const key = JSON.stringify([notice.threadId, notice.turnId])
      if (received.has(key)) return
      received.add(key)
      const entry = start(notice.threadId, notice.turnId)
      entry.peek = {
        answer: notice.outcome === 'completed' ? notice.body : null,
        error: notice.outcome === 'failed' ? notice.body : null,
        pending: null,
        ...(notice.outcome !== 'completed' ? { outcome: notice.outcome } : {}),
      }
      entry.complete = true
      for (const receive of listeners.get(notice.threadId) ?? []) receive(entry.peek)
    },
    observe(method: string, params: unknown) {
      const p = params as {
        threadId: string
        turnId: string
        itemId: string
        delta: string
        item: ThreadItem
        turn: Turn
      }
      if (method === 'turn/started') start(p.threadId, p.turn.id)
      if (method === 'item/agentMessage/delta') {
        const entry = start(p.threadId, p.turnId)
        if (entry.complete) return
        entry.peek.answer = (entry.itemId === p.itemId ? (entry.peek.answer ?? '') : '') + p.delta
        entry.itemId = p.itemId
      }
      if (method === 'item/completed' && p.item.type === 'agentMessage' && p.item.text.trim()) {
        const entry = start(p.threadId, p.turnId)
        if (entry.complete) return
        entry.itemId = p.item.id
        entry.peek.answer = p.item.text
      }
      if (method !== 'turn/completed') return
      const entry = start(p.threadId, p.turn.id)
      const { turn, items } = projectTurn(p.turn)
      const byId = new Map(items.map((item) => [item.id, item]))
      const peek = peekOf(turn, (id) => byId.get(id), [])
      entry.peek = { ...peek, answer: peek.answer ?? entry.peek.answer?.trim() ?? null }
      // notLoaded 只说明回合状态；既没见过条目流也没带摘要时仍要取历史。
      entry.complete = p.turn.itemsView !== 'notLoaded' || !!entry.peek.answer || !!entry.peek.error
      if (entry.complete) for (const receive of listeners.get(p.threadId) ?? []) receive(entry.peek)
    },
    async read(
      threadId: string,
      read: () => Promise<SessionPeek>,
      grace?: { clock: Clock; ms: number },
    ): Promise<SessionPeek> {
      const known = ready(threadId)
      if (known) return known
      // Codex 先报 idle 再报 turn/completed。两者之间已开始的历史请求不应阻塞通知。
      let receive: (peek: SessionPeek) => void = () => {}
      const completed = new Promise<SessionPeek>((resolve) => {
        receive = resolve
      })
      const waiting = listeners.get(threadId) ?? new Set()
      waiting.add(receive)
      listeners.set(threadId, waiting)
      // 新设备的全局状态可能先于摘要到达；给轻量摘要一小段投递时间，避免抢先读慢历史。
      let cancel = () => {}
      const history = grace
        ? new Promise<SessionPeek>((resolve, reject) => {
            cancel = grace.clock.setTimer(() => {
              void read().then(resolve, reject)
            }, grace.ms)
          })
        : read()
      try {
        return await Promise.race([completed, history])
      } finally {
        cancel()
        waiting.delete(receive)
        if (!waiting.size) listeners.delete(threadId)
      }
    },
  }
}
