import type { OpenedUnread, SessionChildren, SidebarProjectionRow } from '@litch/core'
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
  clicked: { mode: Mode; selection: Selection; previous: RowSelection | null } | null
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
    clicked: { mode, selection, previous: was.rows[mode] },
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
  // 最近里的经理会跨模式打开。来源模式仍显示原会话，返回时不能高亮刚点过的经理。
  const rows =
    was.clicked && was.clicked.mode !== mode
      ? { ...was.rows, [was.clicked.mode]: was.clicked.previous }
      : was.rows
  return {
    mode,
    rows:
      restored || direct
        ? rows
        : { ...rows, [mode]: navigatedRow(rows[mode], selection, autoLocate) },
    viewed: { ...was.viewed, [mode]: selection },
    clicked: null,
    request: !restored && !direct && autoLocate ? selection : null,
  }
}

export function sameSession(a: Selection | null, b: Selection | null): boolean {
  return !!a && !!b && a.deviceId === b.deviceId && a.sessionId === b.sessionId
}

/** 未读暂留跟随整棵会话树；原生子会话和 Litch 子会话都用目录里的父链。 */
export function projectionRoot(
  selection: Selection | null,
  children: SessionChildren,
): Selection | null {
  if (!selection) return null
  const parents = new Map(
    Object.entries(children).flatMap(([parent, kids]) => kids.map((id) => [id, parent] as const)),
  )
  let id = selection.sessionId
  const seen = new Set<string>()
  while (parents.has(id) && !seen.has(id)) {
    seen.add(id)
    id = parents.get(id) ?? id
  }
  return { deviceId: selection.deviceId, sessionId: id }
}

export interface UnreadMemory {
  root: Selection | null
  opened: OpenedUnread | null
}

/**
 * 根项没换也可能刚进入未读（正在看的父会话有子会话完成），第一次出现时同样记住位置。
 * 清未读、更新排序或在同棵树内切换不重记；切到别的树或离开对话才释放。
 */
export function rememberUnread(
  was: UnreadMemory,
  root: Selection | null,
  rows: readonly SidebarProjectionRow[],
): UnreadMemory {
  const staying = sameSession(was.root, root) || (was.root === null && root === null)
  if (staying && was.opened) return was
  const index = rows.findIndex((row) => sameSession(row, root))
  const row = rows[index]
  if (staying && !row) return was
  return { root, opened: row ? { row, index } : null }
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
