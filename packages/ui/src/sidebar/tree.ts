// 会话树在列表里怎么排：哪些子会话挂到父会话下面去画、收起了的父会话下面还露出哪些、最多套几层。
// 只管算，不碰页面，桌面侧栏（Sidebar.tsx）和手机的会话列表（apps/mobile 的 sessions/list.ts）共用。
// 谁是谁的子会话、兄弟之间的先后由核心算好（keys.children），这里不再排。
import type { SessionChildren, SessionGroups } from '@litch/core'

/** 子会话最多套几层：父子关系由设备进程保证不成环；万一对面给错了，也不至于一直套下去 */
export const MAX_DEPTH = 8

/**
 * 挂到父会话下面去画的子会话：父会话这时也画在列表里（没被筛掉、没藏起来）的那些。
 * listed 是各组里要画的会话（还没去掉子会话）；父会话被筛掉了的，子会话照常排在自己那一组里
 */
export function nestedUnder(listed: Iterable<string>, children: SessionChildren): Set<string> {
  const shown = new Set(listed)
  return new Set(
    Object.entries(children).flatMap(([parent, ids]) => (shown.has(parent) ? ids : [])),
  )
}

/** 父会话下面现在露出来的子会话：收起了只露出非露出来不可的（正选中的、停下来等人的） */
export const kidsShown = (
  kids: readonly string[],
  folded: boolean,
  always: (sessionId: string) => boolean,
): readonly string[] => (folded ? kids.filter(always) : kids)

/** 未读或待处理的后代需要整条父链可达，不能藏在已读父项或分页后面。 */
export function withAncestors(ids: Iterable<string>, children: SessionChildren): Set<string> {
  const parents = new Map<string, string>()
  for (const [parent, kids] of Object.entries(children))
    for (const id of kids) parents.set(id, parent)
  const kept = new Set(ids)
  for (const id of kept) {
    const parent = parents.get(id)
    if (parent) kept.add(parent)
  }
  return kept
}

export type TreeUnread = Readonly<Record<string, number>>

/**
 * 按展开后的树计未读：子项跟随实际显示的根会话，不再记到它自己的项目。
 * groups 必须先经过与列表相同的可见性筛选；归档和经理子树不在普通目录中。
 * 不依赖组的开合与分页；超过列表深度上限、环或不在目录里的子项不贡献数字。
 */
export function treeUnread(
  groups: SessionGroups,
  children: SessionChildren,
  unread: readonly string[],
): TreeUnread {
  const listed = new Set(Object.values(groups).flat())
  const nested = nestedUnder(listed, children)
  const unseen = new Set(unread)
  const counted = new Set<string>()
  const counts: Record<string, number> = {}
  const visit = (id: string, group: string, depth: number) => {
    if (depth > MAX_DEPTH || !listed.has(id) || counted.has(id)) return
    counted.add(id)
    if (unseen.has(id)) counts[group] = (counts[group] ?? 0) + 1
    for (const kid of children[id] ?? []) visit(kid, group, depth + 1)
  }
  for (const [group, ids] of Object.entries(groups))
    for (const id of ids) if (!nested.has(id)) visit(id, group, 0)
  return counts
}

export function unreadIn(counts: TreeUnread, group: string | readonly string[] | null): number {
  const names = group === null ? Object.keys(counts) : typeof group === 'string' ? [group] : group
  return names.reduce((sum, name) => sum + (counts[name] ?? 0), 0)
}
