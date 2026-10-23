// 引擎报后台任务（backgroundTasks 扩展，protocol/extensions/background-tasks.json）时，应答和通知怎么加字段。
// Pi、OpenCode、ACP 入口的后台 shell（background-shell.mts）共用；dsh 入口有自己的一份（packages/dsh/src/protocol.mts）。
// 只改给声明了扩展的连接的那一份：应答里的会话对象带上 litchBackground（有任务时），回合带上 litchOrigin（有来历时）。
// 回合对象可能是引擎记着的那一份，先拷一份再加，别的连接看到的不变。
import type { LitchBackgroundTask, LitchTurnOrigin } from '../../protocol/src/background-tasks.mjs'
import { ProtocolError } from './protocol-contract.mjs'

export interface BackgroundReport {
  /** 这条连接握手时声明了 backgroundTasks */
  declared(peerId: string): boolean
  /** 这个会话的集合（运行中的在前，结束过的在后） */
  tasks(threadId: string): LitchBackgroundTask[]
  /** 这个回合是谁开的；用户发起的给 undefined */
  origin(threadId: string, turnId: string): LitchTurnOrigin | undefined
  /** 后台任务结束后会不会自己接着做 */
  wakes: boolean
}

function markTurns(report: BackgroundReport, threadId: string, turns: unknown): unknown {
  if (!Array.isArray(turns)) return turns
  return turns.map((turn) => {
    const origin =
      turn && typeof turn.id === 'string' ? report.origin(threadId, turn.id) : undefined
    return origin ? { ...turn, litchOrigin: origin } : turn
  })
}

/**
 * 应答：result.thread、result.data（会话列表）里的会话对象挂上集合，回合标来历。
 * turnsOf 给了时 result.data 是这个会话的回合（thread/turns/list）。应答对象是这次现拼的，直接改它的字段
 */
export function withBackground<T>(
  report: BackgroundReport,
  peerId: string,
  result: T,
  turnsOf?: string,
): T {
  if (!report.declared(peerId)) return result
  const body = result as any
  if (turnsOf) {
    if (Array.isArray(body?.data)) body.data = markTurns(report, turnsOf, body.data)
    return result
  }
  const mark = (thread: any) => {
    if (!thread || typeof thread.id !== 'string') return
    const tasks = report.tasks(thread.id)
    if (tasks.length > 0) thread.litchBackground = { tasks, wakesOnFinish: report.wakes }
    if (Array.isArray(thread.turns)) thread.turns = markTurns(report, thread.id, thread.turns)
  }
  if (Array.isArray(body?.data)) for (const thread of body.data) mark(thread)
  mark(body?.thread)
  return result
}

/** turn/started、turn/completed 发给声明过的连接时带上来历（另拷一份）。别的通知、没有来历的原样返回 */
export function notificationWithOrigin(
  report: BackgroundReport,
  peerId: string,
  threadId: string | null,
  method: string,
  params: any,
): any {
  if (threadId === null || (method !== 'turn/started' && method !== 'turn/completed')) return params
  const turnId = params?.turn?.id
  if (typeof turnId !== 'string' || !report.declared(peerId)) return params
  const origin = report.origin(threadId, turnId)
  return origin ? { ...params, turn: { ...params.turn, litchOrigin: origin } } : params
}

/**
 * thread/backgroundTerminals/list 的一页（照 Codex 0.163.0：cursor 是上一页最后一条的 processId，
 * 已经不在列表里时给空页；limit 省略是全部）
 */
export function backgroundTerminalsPage<T extends { processId: string }>(
  terminals: T[],
  params: { cursor?: unknown; limit?: unknown },
): { data: T[]; nextCursor: string | null } {
  const { cursor, limit } = params
  if (cursor != null && typeof cursor !== 'string')
    throw new ProtocolError(-32602, 'cursor 必须是字符串')
  if (limit != null && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0))
    throw new ProtocolError(-32602, 'limit 必须是非负整数')
  const at = cursor == null ? -1 : terminals.findIndex((terminal) => terminal.processId === cursor)
  const start = cursor == null ? 0 : at < 0 ? terminals.length : at + 1
  const size = Math.max(1, (limit as number | null | undefined) ?? terminals.length)
  const end = Math.min(terminals.length, start + size)
  return {
    data: terminals.slice(start, end),
    nextCursor: end < terminals.length ? (terminals[end - 1]?.processId ?? null) : null,
  }
}
