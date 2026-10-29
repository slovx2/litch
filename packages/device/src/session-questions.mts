// 只缓存待答派生结果，不缓存整段历史。通知只标记可能影响集合的变化；纯工具进度、
// 回报和普通助手输出不会造成下一次唤醒重读长会话。退订/断连后无法保证没漏通知，须作废。
import type { PendingQuestion } from '../../protocol/src/pending-asks.mjs'
import { pendingHistory, questionsOfHistory } from '../../protocol/src/pending-history.mjs'
import { isUserReply } from '../../protocol/src/user-reply.mjs'
import { isObject } from './wire.mjs'

interface Entry {
  questions: PendingQuestion[]
  dirty: boolean
  revision: number
}

export class SessionQuestions {
  private readonly entries = new Map<string, Entry>()

  clear(threadId?: string): void {
    if (threadId === undefined) this.entries.clear()
    else this.entries.delete(threadId)
  }

  event(method: string, params: Record<string, unknown>): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId : null
    if (!threadId) return
    const entry = this.entries.get(threadId)
    if (!entry) return
    if (method === 'thread/reverted' || method === 'thread/deleted' || method === 'thread/closed') {
      this.clear(threadId)
      return
    }
    const turn = isObject(params.turn) ? params.turn : null
    const items = isObject(params.item)
      ? [params.item]
      : Array.isArray(turn?.items)
        ? turn.items
        : []
    for (const [index, item] of items.entries()) {
      if (!isObject(item)) continue
      const args = isObject(item.arguments) ? item.arguments : {}
      const asks =
        item.type === 'agentMessage' && Array.isArray(item.questions) && item.questions.length > 0
      const wraps =
        item.type === 'dynamicToolCall' &&
        item.namespace === 'litch_sessions' &&
        item.tool === 'wrap_up' &&
        ((typeof args.ask === 'string' && args.ask.trim()) ||
          (Array.isArray(args.withdraw_questions) && args.withdraw_questions.length))
      // 空集合遇到用户消息仍然为空；会话间消息和纯回报不改变未答题。
      let replies = false
      if (item.type === 'userMessage' && (entry.dirty || entry.questions.length > 0)) {
        const view = pendingHistory({
          turns: [{ id: 'event', items: [item], litchOrigin: turn?.litchOrigin }],
        })
        const first = view.turns[0]
        replies = !!first && isUserReply(view.items[first.itemIds[0] ?? ''], first.origin, index)
      }
      if (asks || wraps || replies) {
        entry.dirty = true
        entry.revision++
      }
    }
  }

  async read(
    threadId: string,
    load: () => Promise<Record<string, unknown>>,
  ): Promise<PendingQuestion[]> {
    let entry = this.entries.get(threadId)
    if (entry && !entry.dirty) return entry.questions
    if (!entry) {
      // 只保留用过的会话；上限防常驻服务无限积累。
      if (this.entries.size >= 10_000) this.entries.clear()
      entry = { questions: [], dirty: true, revision: 0 }
      this.entries.set(threadId, entry)
    }
    const revision = entry.revision
    const thread = await load()
    if (!Array.isArray(thread.turns)) throw new Error('includeTurns was not returned')
    const questions = questionsOfHistory(thread)
    // 读取途中有新消息、回退或断连：这一份不能冒充当前快照，下次再取。
    if (this.entries.get(threadId) !== entry || entry.revision !== revision) return []
    entry.questions = questions
    entry.dirty = false
    return questions
  }
}
