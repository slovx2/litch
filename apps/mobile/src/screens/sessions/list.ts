// 会话列表摊平成一维的行：FlashList 只画看得见的那几十行，分组标题也是其中的一行。
// 顺序照桌面端侧栏：置顶、各个自定义分区、各个工作区（按设备给的顺序）、不属于任何工作区的，最后是已归档。
// 这里只排行，不碰数据：会话行只带标识，各行自己订阅自己的摘要（keys.summary）。
import {
  groupOfSection,
  LOOSE,
  PINNED,
  type SectionView,
  type SessionGroups,
  type SessionSummary,
  type WorkspaceView,
} from '@litch/core'

export type GroupHead =
  | { kind: 'pinned' }
  | { kind: 'section'; section: SectionView }
  | { kind: 'workspace'; workspace: WorkspaceView }
  | { kind: 'loose' }

export type ListItem =
  | { type: 'group'; key: string; head: GroupHead; count: number; collapsed: boolean }
  | { type: 'session'; key: string; id: string }
  | { type: 'archivedHead'; key: string; open: boolean }
  /** 已归档的会话不在 keys.summary 里，摘要随列表一起来 */
  | { type: 'archived'; key: string; summary: SessionSummary }
  | { type: 'archivedNote'; key: string; note: 'loading' | 'empty' | 'offline' }

export interface ListInput {
  groups: SessionGroups
  sections: SectionView[]
  workspaces: WorkspaceView[]
  /** 收起来的组（组的键，和 SessionGroups 的一样） */
  collapsed: ReadonlySet<string>
  /** 已归档那一段展开着没有，展开了才有 archived */
  archivedOpen: boolean
  /** null：还没取到 */
  archived: SessionSummary[] | null
  /** 设备没连着：没取过的已归档也取不到 */
  offline: boolean
}

export function buildList(input: ListInput): ListItem[] {
  const { groups, collapsed } = input
  const items: ListItem[] = []
  const push = (groupKey: string, head: GroupHead, always: boolean) => {
    const ids = groups[groupKey] ?? []
    // 置顶、分区、无工作区这几组没有会话就不画；工作区没有会话也画出标题，好在下面新建
    if (ids.length === 0 && !always) return
    const shut = collapsed.has(groupKey)
    items.push({ type: 'group', key: `g:${groupKey}`, head, count: ids.length, collapsed: shut })
    if (shut) return
    for (const id of ids) items.push({ type: 'session', key: `s:${id}`, id })
  }
  push(PINNED, { kind: 'pinned' }, false)
  for (const section of input.sections) {
    push(groupOfSection(section.id), { kind: 'section', section }, false)
  }
  for (const workspace of input.workspaces)
    push(workspace.id, { kind: 'workspace', workspace }, true)
  push(LOOSE, { kind: 'loose' }, false)
  items.push({ type: 'archivedHead', key: 'a:head', open: input.archivedOpen })
  if (input.archivedOpen) {
    if (input.archived === null)
      items.push({
        type: 'archivedNote',
        key: 'a:note',
        note: input.offline ? 'offline' : 'loading',
      })
    else if (input.archived.length === 0)
      items.push({ type: 'archivedNote', key: 'a:note', note: 'empty' })
    else
      for (const summary of input.archived)
        items.push({ type: 'archived', key: `a:${summary.id}`, summary })
  }
  return items
}

/** 组标题行在 SessionGroups 里的键（收起、展开按它记） */
export function groupKeyOf(head: GroupHead): string {
  switch (head.kind) {
    case 'pinned':
      return PINNED
    case 'section':
      return groupOfSection(head.section.id)
    case 'workspace':
      return head.workspace.id
    case 'loose':
      return LOOSE
  }
}
