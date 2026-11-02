import type { SessionChildren, SidebarProjectionRow } from '@litch/core'
import type { Selection } from '../app/App.tsx'
import { containsSession } from './reveal.ts'

export type RowSource = 'tree' | 'recent' | 'unread'
export interface RowSelection extends Selection {
  source: RowSource
}

type Mode = 'chat' | 'manager'
export interface RowMemory {
  mode: Mode
  rows: Record<Mode, RowSelection | null>
  viewed: Record<Mode, Selection | null>
  clicked: { mode: Mode; selection: Selection } | null
  request: Selection | null
}

export function rowMemory(mode: Mode): RowMemory {
  return {
    mode,
    rows: { chat: null, manager: null },
    viewed: { chat: null, manager: null },
    clicked: null,
    request: null,
  }
}

export function clickedRow(
  was: RowMemory,
  mode: Mode,
  selection: Selection,
  source: RowSource,
): RowMemory {
  return {
    ...was,
    rows: { ...was.rows, [mode]: { ...selection, source } },
    clicked: { mode, selection },
    request: null,
  }
}

/** 模式切换复用该模式原有的导航对象；外部重开同一会话仍会给新对象，应继续定位。 */
export function navigateRows(
  was: RowMemory,
  mode: Mode,
  selection: Selection | null,
  autoLocate: boolean,
): RowMemory {
  const restored = was.mode !== mode && was.viewed[mode] === selection
  const direct =
    selection !== null && was.clicked?.mode === mode && was.clicked.selection === selection
  return {
    mode,
    rows:
      restored || direct
        ? was.rows
        : { ...was.rows, [mode]: navigatedRow(was.rows[mode], selection, autoLocate) },
    viewed: { ...was.viewed, [mode]: selection },
    clicked: null,
    request: !restored && !direct && autoLocate ? selection : null,
  }
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
