import type { EngineLink } from './engine-link.mjs'
import { isObject } from './wire.mjs'

/** 默认只读元数据；确需历史时按页消费，禁止退回整份 thread/read。 */
export async function* historyPages(
  link: Pick<EngineLink, 'request'>,
  threadId: string,
  latest?: number,
  timeoutMs?: number,
): AsyncGenerator<Record<string, any>[]> {
  const seen = new Set<string>()
  let cursor: string | null = null
  let count = 0
  do {
    const page = await link.request(
      'thread/turns/list',
      {
        threadId,
        limit: latest === undefined ? 10 : Math.min(10, latest - count),
        sortDirection: 'desc',
        itemsView: 'full',
        ...(cursor === null ? {} : { cursor }),
      },
      timeoutMs === undefined ? undefined : { timeoutMs },
    )
    if (!isObject(page) || !Array.isArray(page.data)) throw new Error('历史分页应答缺少 data')
    const turns = page.data.filter(isObject)
    count += turns.length
    yield turns
    cursor = typeof page.nextCursor === 'string' ? page.nextCursor : null
    if (cursor !== null && seen.has(cursor)) throw new Error('历史分页游标重复，已停止读取')
    if (cursor !== null) seen.add(cursor)
  } while (cursor !== null && (latest === undefined || count < latest))
}

export async function sessionHistory(
  link: Pick<EngineLink, 'request' | 'native'>,
  threadId: string,
  includeTurns: boolean,
  latest?: number,
  timeoutMs?: number,
): Promise<Record<string, any>> {
  const result = await link.request(
    'thread/read',
    { threadId, includeTurns: includeTurns && !link.native },
    timeoutMs === undefined ? undefined : { timeoutMs },
  )
  const thread = isObject(result) && isObject(result.thread) ? result.thread : null
  if (!thread) throw new Error(`没有给回会话 ${threadId}`)
  if (!includeTurns || !link.native) return thread
  const turns: Record<string, unknown>[] = []
  for await (const page of historyPages(link, threadId, latest, timeoutMs)) turns.push(...page)
  return { ...thread, turns: turns.reverse() }
}

/** 查一个确定回合时逐页找，找到就停，不在内存中攒整份历史。 */
export async function sessionTurn(
  link: Pick<EngineLink, 'request' | 'native'>,
  threadId: string,
  turnId: string,
) {
  if (!link.native) {
    const thread = await sessionHistory(link, threadId, true)
    return (
      (Array.isArray(thread.turns) ? thread.turns : []).find((turn: any) => turn.id === turnId) ??
      null
    )
  }
  for await (const page of historyPages(link, threadId)) {
    const turn = page.find((entry) => entry.id === turnId)
    if (turn) return turn
  }
  return null
}

/** 重连成功不代表坏会话已恢复；失败预算按会话保留，避免每次断链重置成第零次。 */
export class SessionRecoveryBudget {
  private readonly failures = new Map<string, { count: number; after: number }>()
  private readonly running = new Set<string>()
  private readonly delays: readonly number[]
  constructor(delays = [1000, 2000, 5000, 10_000, 30_000]) {
    this.delays = delays
  }
  begin(id: string, now = Date.now()): boolean {
    const state = this.failures.get(id)
    if (this.running.has(id) || (state && (state.count >= this.delays.length || now < state.after)))
      return false
    this.running.add(id)
    return true
  }
  finish(id: string, success: boolean, now = Date.now()): number | null {
    this.running.delete(id)
    if (success) {
      this.failures.delete(id)
      return null
    }
    const count = (this.failures.get(id)?.count ?? 0) + 1
    const delay = this.delays[count - 1] ?? 0
    this.failures.set(id, { count, after: now + delay })
    return count >= this.delays.length ? null : delay
  }
}
