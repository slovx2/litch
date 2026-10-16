import { createHash } from 'node:crypto'

export class ProtocolError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

/**
 * 这个入口上没有这个会话。话术照上游（`thread not found: <会话号>`）：官方桌面端找一个会话在哪台机器上时，
 * 拿会话号向每个连着的入口都问一遍，按错误的话术认“这里没有”（错误码它不看），认不出就当这台机器出了错。
 * 所以别的 harness 的会话号到这里是常事，答它不算入口出了毛病。错误码照我们一直用的 -32602（上游是 -32600）。
 */
export class ThreadNotFound extends ProtocolError {
  constructor(threadId: string) {
    super(-32602, `thread not found: ${threadId}`)
  }
}

/**
 * 上游发给所有连接的会话级通知，别的会话级通知只发给订阅着这个会话的连接。依据是 rust-v0.162.0-alpha.20 的
 * app-server：这些经全局的 `OutgoingMessageSender` 发（`thread_processor` 的新建、改名、归档、取消归档、删除、
 * 回退、归属、附件，`thread_status` 的 `ThreadWatchManager` 发状态，`thread_lifecycle` 卸载时发关闭），广播给每条
 * 握手过的连接；回合、条目、设置、用量、队列、服务端请求的结果这些经 `ThreadScopedOutgoingMessageSender`，只给订阅者。
 * 没订阅、也没读过一个会话的客户端（侧栏上别处在跑的会话）靠前一种跟着它变。
 */
export const BROADCAST_THREAD_NOTIFICATIONS: ReadonlySet<string> = new Set([
  'thread/started',
  'thread/status/changed',
  'thread/name/updated',
  'thread/archived',
  'thread/unarchived',
  'thread/closed',
  'thread/deleted',
  'thread/reverted',
  'thread/project/updated',
  'thread/attachment/updated',
  'thread/goal/updated',
  'thread/goal/cleared',
])

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new ProtocolError(-32602, `${name} 必须是非空字符串`)
  return value
}

// 对象键顺序不影响提交身份；输入数组顺序仍有语义。
export function submissionHash(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical)
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      )
    return input
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}

// include 在游标定位之后过滤：游标属于整个序列，过滤条件不影响它的有效性。
export function pageRecords<T>(
  records: T[],
  params: Record<string, unknown>,
  scope: string,
  identity: (record: T) => string,
  include: (record: T) => boolean = () => true,
) {
  const limit = params.limit ?? 50
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new ProtocolError(-32602, 'limit 必须在 1 到 1000 之间')
  const direction = params.sortDirection ?? 'desc'
  if (direction !== 'asc' && direction !== 'desc')
    throw new ProtocolError(-32602, 'sortDirection 无效')
  const ordered = direction === 'desc' ? [...records].reverse() : records
  let offset = 0
  if (params.cursor != null) {
    try {
      const cursor = JSON.parse(
        Buffer.from(requiredString(params.cursor, 'cursor'), 'base64url').toString(),
      )
      const index = ordered.findIndex((item) => identity(item) === cursor.id)
      if (cursor.scope !== scope || index < 0) throw new Error('游标不属于本次查询')
      offset = index + (cursor.inclusive === true ? 0 : 1)
    } catch {
      throw new ProtocolError(-32602, '历史游标无效或已失效')
    }
  }
  const remaining = ordered.slice(offset).filter(include)
  const data = remaining.slice(0, limit)
  const cursorFor = (record: T, inclusive = false) =>
    Buffer.from(JSON.stringify({ scope, id: identity(record), inclusive })).toString('base64url')
  return {
    data,
    nextCursor: limit < remaining.length && data.length ? cursorFor(data[data.length - 1]!) : null,
    backwardsCursor: data.length ? cursorFor(data[0]!, true) : null,
  }
}

type HistoryTurn<I extends { id: string } = { id: string }> = { id: string; items: I[] }

// 条目游标是线程级的：桌面拿 thread/resume 给的同一个头部游标，逐个回合带 turnId 取条目。
export function pageThreadItems<I extends { id: string }>(
  threadId: string,
  turns: HistoryTurn<I>[],
  params: Record<string, unknown>,
) {
  return pageRecords(
    turns.flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item }))),
    params,
    `items:${threadId}`,
    (entry) => `${entry.turnId}:${entry.item.id}`,
    (entry) => !params.turnId || entry.turnId === params.turnId,
  )
}

// thread/resume 与 thread/revert 返回的头部游标：包含最新回合与最新条目，历史为空时为 null。
export function historyHeadCursors(threadId: string, turns: HistoryTurn[]) {
  const head = { limit: 1, sortDirection: 'desc' }
  return {
    turnsBackwardsCursor: pageRecords(turns, head, `turns:${threadId}`, (turn) => turn.id)
      .backwardsCursor,
    itemsBackwardsCursor: pageThreadItems(threadId, turns, head).backwardsCursor,
  }
}
