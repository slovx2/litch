// 会话列表摊平成一维的行：FlashList 只画看得见的那几十行，分组标题也是其中的一行。
// 顺序照桌面端侧栏：置顶、各个自定义分区、内置的“项目”组、不属于任何工作区的，最后是已归档。
// 工作区排在它所在的那一组里（置顶的在置顶里、进了分区的在分区里，其余的都在“项目”里），收起一组连里面的工作区一起收起。
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

/**
 * 内置的“项目”组的键：设备上没有这一组，只是界面上把不在置顶、分区里的工作区收在一起。
 * 不能删、不能改名；和 SessionGroups 的键不会撞上
 */
export const PROJECTS = ':projects'

export type GroupHead =
  | { kind: 'pinned' }
  | { kind: 'section'; section: SectionView }
  | { kind: 'projects' }
  | { kind: 'workspace'; workspace: WorkspaceView }
  | { kind: 'loose' }

export type ListItem =
  | {
      type: 'group'
      key: string
      head: GroupHead
      count: number
      collapsed: boolean
      /** 排在置顶、分区、“项目”里的工作区标题：往里缩一点 */
      inner: boolean
      /** 收起时行尾汇总哪几组（“项目”是它里面的各个工作区）。没有就是它自己那一组 */
      tally?: string[]
    }
  | { type: 'session'; key: string; id: string }
  | { type: 'archivedHead'; key: string; open: boolean }
  /** 已归档的会话不在 keys.summary 里，摘要随列表一起来 */
  | { type: 'archived'; key: string; summary: SessionSummary }
  | { type: 'archivedNote'; key: string; note: 'loading' | 'empty' | 'offline' }

export interface ListInput {
  groups: SessionGroups
  sections: SectionView[]
  workspaces: WorkspaceView[]
  /** 收起来的组（组的键，和 SessionGroups 的一样；“项目”是 PROJECTS） */
  collapsed: ReadonlySet<string>
  /** 已归档那一段展开着没有，展开了才有 archived */
  archivedOpen: boolean
  /** null：还没取到 */
  archived: SessionSummary[] | null
  /** 设备没连着：没取过的已归档也取不到 */
  offline: boolean
  /** 设备能整理（能加工作区）：这时“项目”空着也画出标题，好在那里添加 */
  organizable: boolean
}

export function buildList(input: ListInput): ListItem[] {
  const { groups, collapsed, workspaces } = input
  const items: ListItem[] = []
  const sessions = (groupKey: string) => {
    for (const id of groups[groupKey] ?? []) items.push({ type: 'session', key: `s:${id}`, id })
  }
  /** 一个工作区：标题（没有会话也画，好在下面新建）和它的会话 */
  const workspace = (entry: WorkspaceView, inner: boolean) => {
    const shut = collapsed.has(entry.id)
    const count = groups[entry.id]?.length ?? 0
    const head: GroupHead = { kind: 'workspace', workspace: entry }
    items.push({ type: 'group', key: `g:${entry.id}`, head, count, collapsed: shut, inner })
    if (!shut) sessions(entry.id)
  }
  /** 置顶、一个分区、“项目”：里面的会话在前，工作区在后。都空着的不画（always 的除外） */
  const band = (groupKey: string, head: GroupHead, inside: WorkspaceView[], always: boolean) => {
    const count = groups[groupKey]?.length ?? 0
    if (count === 0 && inside.length === 0 && !always) return
    const shut = collapsed.has(groupKey)
    const tally = head.kind === 'projects' ? { tally: inside.map((entry) => entry.id) } : {}
    items.push({
      type: 'group',
      key: `g:${groupKey}`,
      head,
      count,
      collapsed: shut,
      inner: false,
      ...tally,
    })
    if (shut) return
    sessions(groupKey)
    for (const entry of inside) workspace(entry, true)
  }
  band(
    PINNED,
    { kind: 'pinned' },
    workspaces.filter((entry) => entry.pinned),
    false,
  )
  for (const section of input.sections) {
    band(
      groupOfSection(section.id),
      { kind: 'section', section },
      workspaces.filter((entry) => !entry.pinned && entry.sectionId === section.id),
      false,
    )
  }
  band(
    PROJECTS,
    { kind: 'projects' },
    workspaces.filter((entry) => !entry.pinned && !entry.sectionId),
    input.organizable,
  )
  // 不属于任何工作区的：没有会话就不画
  if ((groups[LOOSE]?.length ?? 0) > 0) {
    const shut = collapsed.has(LOOSE)
    const head: GroupHead = { kind: 'loose' }
    const count = groups[LOOSE]?.length ?? 0
    items.push({ type: 'group', key: `g:${LOOSE}`, head, count, collapsed: shut, inner: false })
    if (!shut) sessions(LOOSE)
  }
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
    case 'projects':
      return PROJECTS
    case 'workspace':
      return head.workspace.id
    case 'loose':
      return LOOSE
  }
}
