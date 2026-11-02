// 历史分页只使用 app-server 已有的请求。旧端忽略/拒绝分页参数时仍能读完整历史。
import type {
  Thread,
  ThreadResumeResponse,
  ThreadTurnsListResponse,
} from '../../../protocol/src/index.mjs'
import { RpcError } from '../connection/rpc.mjs'

export const HISTORY_PAGE_SIZE = 10
export const INITIAL_HISTORY = {
  excludeTurns: true,
  initialTurnsPage: { limit: HISTORY_PAGE_SIZE, sortDirection: 'desc', itemsView: 'full' },
} as const

/** 只有方法/参数明确不支持才回退，不能把网络故障、权限错误当作旧设备。 */
export function lacksPaging(error: unknown): boolean {
  return error instanceof RpcError && [-32601, -32602, -32600].includes(error.code)
}

export function initialHistory(
  resumed: ThreadResumeResponse,
): { thread: Thread; cursor: string | null } | null {
  const page = resumed.initialTurnsPage
  if (!page || !Array.isArray(page.data)) return null
  return { thread: { ...resumed.thread, turns: [...page.data].reverse() }, cursor: page.nextCursor }
}

export function historyPage(thread: Thread, page: ThreadTurnsListResponse) {
  return { thread: { ...thread, turns: [...page.data].reverse() }, cursor: page.nextCursor }
}
