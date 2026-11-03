import type { SessionChildren, SessionSummary } from '@litch/core'
import { dropNativeChildren } from '../../../../../packages/ui/src/sidebar/filter.ts'
import { kidsShown, MAX_DEPTH } from '../../../../../packages/ui/src/sidebar/tree.ts'

export interface TreeRow {
  id: string
  depth: number
  kids: number
  folded: boolean
}

/** 桌面投影默认收起；最近只记主动展开的父项，与设备列表各自记忆。 */
export function recentTree(
  root: string,
  children: SessionChildren,
  expanded: readonly string[],
): TreeRow[] {
  const folded = new Set(Object.keys(children).filter((id) => !expanded.includes(id)))
  return sessionTree(root, children, folded, [], () => false)
}

/** 摊平一棵会话树；子项保持核心给出的顺序，最近在调用前按主项分页。 */
export function sessionTree(
  root: string,
  children: SessionChildren,
  folded: ReadonlySet<string>,
  hidden: readonly string[],
  always: (id: string) => boolean,
): TreeRow[] {
  const rows: TreeRow[] = []
  const seen = new Set<string>()
  const visit = (id: string, depth: number) => {
    if (depth > MAX_DEPTH || seen.has(id)) return
    seen.add(id)
    const kids = dropNativeChildren(children[id], hidden, always)
    const shut = folded.has(id)
    rows.push({ id, depth, kids: kids.length, folded: shut })
    for (const kid of kidsShown(kids, shut, always)) visit(kid, depth + 1)
  }
  visit(root, 0)
  return rows
}

/** 包含全部后代，避免未读孙会话藏在已读的中间父项后面。 */
export function descendantIds(root: string, children: SessionChildren): string[] {
  const seen = new Set([root])
  const pending = [...(children[root] ?? [])]
  const ids: string[] = []
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    pending.push(...(children[id] ?? []))
  }
  return ids
}

/** 经理与工作线不在 keys.active 中，折叠提示直接按完整目录摘要判断。 */
export const sessionHasActivity = (summary: SessionSummary | undefined): boolean =>
  !!summary &&
  (summary.unread ||
    summary.status === 'running' ||
    summary.status === 'waiting' ||
    (summary.background?.running ?? 0) > 0)
