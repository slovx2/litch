import type { SessionSummary } from '../model.mjs'
import { managerMark } from './manager.mjs'

export type SidebarProjectionKind = 'unread' | 'recent'
export interface SidebarProjectionRow {
  deviceId: string
  sessionId: string
  workspaceId: string | null
  at: number
}
export type SidebarProjections = Record<SidebarProjectionKind, SidebarProjectionRow[]>

/** 查看未读后暂留的主项和原来的位置；不修改真正的未读状态。 */
export interface OpenedUnread {
  row: SidebarProjectionRow
  index: number
}

export function retainOpenedUnread(
  rows: readonly SidebarProjectionRow[],
  opened: OpenedUnread | null,
): SidebarProjectionRow[] {
  const sorted = [...rows].sort(orderProjection)
  if (!opened) return sorted
  const same = (row: SidebarProjectionRow) =>
    row.deviceId === opened.row.deviceId && row.sessionId === opened.row.sessionId
  const kept = sorted.find(same) ?? opened.row
  const result = sorted.filter((row) => !same(row))
  result.splice(Math.min(Math.max(0, opened.index), result.length), 0, kept)
  return result
}

export const orderProjection = (a: SidebarProjectionRow, b: SidebarProjectionRow): number =>
  b.at - a.at || a.deviceId.localeCompare(b.deviceId) || a.sessionId.localeCompare(b.sessionId)

/** 只读目录摘要；父链路径压缩，深层子树不重复遍历祖先。缺失父项和环不作为独立主会话。 */
export function projectSidebarGroups(
  deviceId: string,
  sessions: ReadonlyMap<string, SessionSummary>,
  interactionTime: (sessionId: string) => number,
): SidebarProjections {
  const roots = new Map<string, string | null>()
  const rootOf = (id: string): string | null => {
    const path = new Set<string>()
    let current = id
    let root: string | null = null
    while (true) {
      if (roots.has(current)) {
        root = roots.get(current) ?? null
        break
      }
      if (path.has(current)) break
      const session = sessions.get(current)
      if (!session || managerMark(session)) break
      path.add(current)
      const parent = session.lineage?.parentId ?? session.nativeLineage?.parentId
      if (!parent) {
        root = session.nativeLineage ? null : current
        break
      }
      current = parent
    }
    for (const entry of path) roots.set(entry, root)
    return root
  }
  const unread = new Map<string, SidebarProjectionRow>()
  const recent = new Map<string, SidebarProjectionRow>()
  const add = (into: Map<string, SidebarProjectionRow>, root: SessionSummary, at: number) => {
    if ((into.get(root.id)?.at ?? -1) >= at) return
    into.set(root.id, { deviceId, sessionId: root.id, workspaceId: root.workspaceId, at })
  }
  for (const session of sessions.values()) {
    const id = rootOf(session.id)
    const root = id ? sessions.get(id) : undefined
    if (!root) continue
    if (session.unread) add(unread, root, session.updatedAt)
    const at = interactionTime(session.id)
    if (at > 0) add(recent, root, at)
  }
  return {
    unread: [...unread.values()].sort(orderProjection),
    recent: [...recent.values()].sort(orderProjection),
  }
}

export interface SidebarProjectionBlock {
  key: string
  deviceId: string
  workspaceId: string | null
  rows: SidebarProjectionRow[]
}

/** 先按主会话分页，再聚合项目；跨设备同名项目不合并，项目按第一页最新项的时间排。 */
export function pageSidebarProjection(
  rows: readonly SidebarProjectionRow[],
  byProject: boolean,
  limit: number,
  opened: OpenedUnread | null = null,
): { blocks: SidebarProjectionBlock[]; remaining: number } {
  const sorted = retainOpenedUnread(rows, opened)
  const shown = sorted.slice(0, Math.max(0, limit))
  const blocks = new Map<string, SidebarProjectionBlock>()
  for (const row of shown) {
    const key = JSON.stringify([row.deviceId, byProject ? row.workspaceId : row.sessionId])
    let block = blocks.get(key)
    if (!block) {
      block = {
        key,
        deviceId: row.deviceId,
        workspaceId: byProject ? row.workspaceId : null,
        rows: [],
      }
      blocks.set(key, block)
    }
    block.rows.push(row)
  }
  return { blocks: [...blocks.values()], remaining: sorted.length - shown.length }
}
