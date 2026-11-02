import type { SessionChildren, SidebarProjectionRow } from '@litch/core'
import type { Selection } from '../app/App.tsx'
import { containsSession } from './reveal.ts'

export type RowSource = 'tree' | 'recent' | 'unread'
export interface RowSelection extends Selection {
  source: RowSource
}

export function sameSession(a: Selection | null, b: Selection | null): boolean {
  return !!a && !!b && a.deviceId === b.deviceId && a.sessionId === b.sessionId
}

/** 外部导航可以定位树行；关掉定位时只保留同一会话已有的选择，不新增高亮。 */
export function navigatedRow(
  previous: RowSelection | null,
  next: Selection | null,
  autoLocate: boolean,
): RowSelection | null {
  if (!next) return null
  if (autoLocate) return { ...next, source: 'tree' }
  return sameSession(previous, next) ? previous : null
}

/** 按身份保留选择，不跟随排序、分页或项目聚合。投影真正移除该会话才回到树行。 */
export function reconcileProjection(
  selected: RowSelection | null,
  kind: 'recent' | 'unread',
  rows: readonly Pick<SidebarProjectionRow, 'deviceId' | 'sessionId'>[],
  children: SessionChildren,
): RowSelection | null {
  if (!selected || selected.source !== kind) return selected
  const present = rows.some(
    (row) =>
      row.deviceId === selected.deviceId &&
      (row.sessionId === selected.sessionId ||
        containsSession(children, row.sessionId, selected.sessionId)),
  )
  return present ? selected : { ...selected, source: 'tree' }
}
