// nebula-host 原生 Codex 0.166.0 rollout 的空推理形状；仅保留结构，标识与时间均为虚构。
// 原记录只给加密推理，summary_text/raw_content 都为空；压缩另发 ContextCompaction。
import type { ThreadItem } from '../../protocol/src/index.mjs'

export const nativeEmptyReasoning = {
  type: 'event_msg',
  timestamp: '2026-01-01T00:00:01.007Z',
  payload: {
    type: 'item_completed',
    thread_id: 'nebula-thread',
    turn_id: 'nebula-turn',
    item: { type: 'Reasoning', id: 'rs_nebula', summary_text: [], raw_content: [] },
    started_at_ms: 1000,
    completed_at_ms: 1007,
  },
} as const

/** app-server 对应的客户端通知条目，started 和 completed 都可能是这份空内容。 */
export const emptyReasoning: ThreadItem = {
  type: 'reasoning',
  id: 'rs_nebula',
  summary: [...nativeEmptyReasoning.payload.item.summary_text],
  content: [...nativeEmptyReasoning.payload.item.raw_content],
}
