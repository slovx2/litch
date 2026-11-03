import { TURN_NOTICE_BODY_MAX, type TurnNotice } from '../../protocol/src/turn-notices.mjs'
import { isObject } from './wire.mjs'

const excerpt = (text: unknown): string | null => {
  if (typeof text !== 'string' || !text.trim()) return null
  const chars = Array.from(text.trim())
  return chars.length > TURN_NOTICE_BODY_MAX
    ? `${chars.slice(0, TURN_NOTICE_BODY_MAX - 1).join('')}…`
    : chars.join('')
}

/** 聚合已有连接的完成事件；不读历史，不为通知新开引擎连接。 */
export class TurnNotices {
  private readonly answers = new Map<string, string>()
  private readonly ended = new Set<string>()
  private readonly announce: (notice: TurnNotice) => void

  constructor(announce: (notice: TurnNotice) => void) {
    this.announce = announce
  }

  observe(method: string, params: Record<string, unknown>): void {
    const threadId = params.threadId
    if (typeof threadId !== 'string') return
    const turn = isObject(params.turn) ? params.turn : null
    const turnId = turn?.id ?? params.turnId
    if (typeof turnId !== 'string') return
    const key = JSON.stringify([threadId, turnId])
    if (this.ended.has(key)) return
    if (
      method === 'item/completed' &&
      isObject(params.item) &&
      params.item.type === 'agentMessage'
    ) {
      const answer = excerpt(params.item.text)
      if (answer) this.answers.set(key, answer)
      const oldest = this.answers.keys().next().value
      if (this.answers.size > 1000 && oldest) this.answers.delete(oldest)
    }
    if (method !== 'turn/completed' || !turn) return
    if (!['completed', 'failed', 'interrupted'].includes(String(turn.status))) return
    const last = Array.isArray(turn.items)
      ? turn.items.findLast(
          (item) => isObject(item) && item.type === 'agentMessage' && excerpt(item.text),
        )
      : undefined
    const answer = excerpt(last?.text) ?? this.answers.get(key) ?? null
    const error = isObject(turn.error) ? excerpt(turn.error.message) : null
    // 某条连接没收到条目，不让空的 notLoaded 事件抢在另一条连接的正文前面。
    if (turn.itemsView === 'notLoaded' && !answer && !error && turn.status === 'completed') return
    this.answers.delete(key)
    this.ended.add(key)
    this.announce({
      threadId,
      turnId,
      outcome: turn.status as TurnNotice['outcome'],
      body: turn.status === 'failed' ? error : answer,
    })
  }
}
