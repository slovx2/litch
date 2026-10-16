// 文件树的键盘操作：按下一个键，该做什么。只看行的清单和选中的是第几行，不碰页面，好单独测。
// 说明行（正在取、没取到、空的、太多了）选不中，上下移动时跳过去。

export interface NavRow {
  path: string
  depth: number
  kind: string
  expanded: boolean
}

export type TreeMove =
  | { do: 'select'; index: number }
  | { do: 'expand'; index: number }
  | { do: 'collapse'; index: number }
  /** 预览打开（空格） */
  | { do: 'preview'; index: number }
  /** 固定打开（回车） */
  | { do: 'open'; index: number }

const NOTES = new Set(['loading', 'failed', 'empty', 'truncated'])

export const selectable = (row: NavRow | undefined): boolean => !!row && !NOTES.has(row.kind)

/** 从 from 起朝 step 的方向找第一个选得中的行。找不到是 -1 */
function seek(rows: readonly NavRow[], from: number, step: 1 | -1): number {
  for (let at = from; at >= 0 && at < rows.length; at += step) {
    if (selectable(rows[at])) return at
  }
  return -1
}

const select = (index: number): TreeMove | null => (index < 0 ? null : { do: 'select', index })

/**
 * at：选中的是第几行，没有选中的是 -1。page：一屏有多少行（翻页键用）。
 * 不认识的键、做不了的事（已经到头了）返回 null：调用的一方就不拦这个键
 */
export function treeMove(
  rows: readonly NavRow[],
  at: number,
  key: string,
  page: number,
): TreeMove | null {
  const row = rows[at]
  const jump = Math.max(1, page - 1)
  switch (key) {
    case 'ArrowDown':
      return select(seek(rows, at + 1, 1))
    case 'ArrowUp':
      return at < 0 ? select(seek(rows, rows.length - 1, -1)) : select(seek(rows, at - 1, -1))
    case 'Home':
      return select(seek(rows, 0, 1))
    case 'End':
      return select(seek(rows, rows.length - 1, -1))
    case 'PageDown': {
      const target = Math.min(rows.length - 1, Math.max(at, 0) + jump)
      const found = seek(rows, target, 1)
      return select(found >= 0 ? found : seek(rows, target, -1))
    }
    case 'PageUp': {
      const target = Math.max(0, Math.max(at, 0) - jump)
      const found = seek(rows, target, -1)
      return select(found >= 0 ? found : seek(rows, target, 1))
    }
    case 'ArrowRight': {
      if (row?.kind !== 'dir') return null
      if (!row.expanded) return { do: 'expand', index: at }
      // 已经展开了：走到它里面的第一项
      const inside = rows[at + 1]
      return inside && inside.depth > row.depth && selectable(inside) ? select(at + 1) : null
    }
    case 'ArrowLeft': {
      if (!row) return null
      if (row.kind === 'dir' && row.expanded) return { do: 'collapse', index: at }
      // 走到上一级目录
      for (let up = at - 1; up >= 0; up--) {
        const above = rows[up]
        if (above && above.depth < row.depth && above.kind === 'dir') return select(up)
      }
      return null
    }
    case 'Enter':
    case ' ': {
      if (!row || !selectable(row)) return null
      if (row.kind === 'dir') return { do: row.expanded ? 'collapse' : 'expand', index: at }
      return { do: key === 'Enter' ? 'open' : 'preview', index: at }
    }
    default:
      return null
  }
}
