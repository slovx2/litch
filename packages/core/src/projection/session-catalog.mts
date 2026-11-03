import type { SessionSummary } from '../model.mjs'
import { managerMark, managerSessionIds } from './manager.mjs'

export type SessionKind = 'conversation' | 'child' | 'manager' | 'line'
export type SessionCatalogEntry = SessionSummary & { kind: SessionKind }
/** 设备当前未归档的全会话目录；不受侧栏分组、折叠或经理区域的过滤影响。 */
export type SessionCatalog = SessionCatalogEntry[]

export function projectSessionCatalog(sessions: Iterable<SessionSummary>): SessionCatalog {
  const rows = [...sessions]
  const managed = managerSessionIds(rows)
  return rows.map((session) => ({
    ...session,
    kind:
      managerMark(session)?.role === 'manager'
        ? 'manager'
        : managed.has(session.id)
          ? 'line'
          : session.lineage || session.nativeLineage
            ? 'child'
            : 'conversation',
  }))
}

/** 数未读线程，不按根聚合，不掺入经理待处理事项或报告已阅状态。 */
export function catalogUnread(catalog: SessionCatalog): string[] {
  return catalog
    .filter((entry) => entry.unread)
    .map((entry) => entry.id)
    .sort()
}
