import { ProtocolError, pageRecords, requiredString } from './protocol-contract.mjs'
import type { SessionStore } from './store.mjs'
import type { ThreadItem, TurnRecord } from './types.mjs'

type TimelineEntry = {
  type: 'item' | 'turnStarted' | 'turnCompleted'
  position: number
  turnId: string
  item?: ThreadItem
  turn_id?: string
  startedAt?: number | null
  started_at?: number | null
  completedAt?: number | null
  completed_at?: number | null
  durationMs?: number | null
  duration_ms?: number | null
  status?: TurnRecord['status']
  error?: unknown
}

export function threadTimelineList(store: SessionStore, params: Record<string, unknown>) {
  const threadId = requiredString(params.threadId, 'threadId')
  if (!store.getThread(threadId)) throw new ProtocolError(-32602, '未知会话')
  const records: Array<{ key: string; entry: TimelineEntry }> = []
  const append = (key: string, entry: Omit<TimelineEntry, 'position'>) => {
    records.push({ key, entry: { ...entry, position: records.length } })
  }
  for (const turn of store.listTurns(threadId)) {
    // 0.157.1 官方 TS/实际 wire 使用驼峰，JSON Schema 的回合边界却使用下划线。
    // 同时输出同源字段，兼容两种消费者；不修改官方 schema 或原生 wire。
    const boundary = {
      turnId: turn.id,
      turn_id: turn.id,
      startedAt: turn.startedAt,
      started_at: turn.startedAt,
    }
    append(`${turn.id}:started`, { type: 'turnStarted', ...boundary })
    for (const item of turn.items)
      append(`${turn.id}:item:${item.id}`, { type: 'item', turnId: turn.id, item })
    // 活动回合不应提前生成完成边界；后续读取直接使用持久化终态。
    if (turn.status !== 'inProgress')
      append(`${turn.id}:completed`, {
        type: 'turnCompleted',
        ...boundary,
        status: turn.status,
        error: turn.error,
        completedAt: turn.completedAt,
        completed_at: turn.completedAt,
        durationMs: turn.durationMs,
        duration_ms: turn.durationMs,
      })
  }
  const { data, nextCursor } = pageRecords(
    records,
    { cursor: params.cursor, limit: params.limit, sortDirection: 'desc' },
    `timeline:${threadId}`,
    (record) => record.key,
  )
  return {
    // 最新一页优先，页内按历史顺序；游标使用条目身份，追加回合不会偏移旧页。
    data: data.reverse().map((record) => record.entry),
    nextCursor,
    activeRealtimeSessionAtPageStart: null,
  }
}
