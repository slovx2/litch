// 侧栏里的拖放：拖的是什么、放到哪、放下去做什么。纯函数，界面在 Sidebar.tsx 里接上。
// 能拖的是会话和工作区（项目）；能放的是置顶、组、工作区那一行、“无项目”。
// 会话只能拖进置顶、组，或者拖回它自己所在的工作区（就是从置顶、组里拿出来）：
// 这一版不支持把会话拖到另一个工作区（菜单里的“移到项目”还在）。
// 工作区能拖进置顶、组，或者拖到外面一个工作区那一行上（放回列表里、排在它前面）。

/** 正在拖的东西。拖的时候记着，放下或者松手就清掉 */
export interface DragItem {
  deviceId: string
  kind: 'session' | 'workspace'
  id: string
  /** 会话所属的工作区；拖的是工作区时是它自己 */
  workspaceId: string | null
  pinned: boolean
  /** 在哪个组里。不在是 null */
  sectionId: string | null
}

/** 放的地方 */
export type DropTarget =
  | { kind: 'pinned' }
  | { kind: 'section'; sectionId: string }
  /** 不在置顶、组里的工作区那一块（行加上它下面的会话） */
  | { kind: 'workspace'; workspaceId: string }
  /** “无项目”那一组 */
  | { kind: 'loose' }

/** 放下去要发的命令（核心的命令名和参数，设备标识另外带） */
export type DropCommand =
  | {
      name: 'session.place'
      params: { sessionId: string; place: 'pinned' | { sectionId: string } | null }
    }
  | {
      name: 'workspace.update'
      params: { workspaceId: string; pinned?: boolean; sectionId?: string | null }
    }
  | { name: 'workspace.move'; params: { workspaceId: string; before: string | null } }

/**
 * 这样东西放到这里要做的事。放不了、或者放下去什么都不变是空数组（界面据此不让放）。
 * 工作区拖到另一个工作区上：先从置顶、组里拿出来（在的话），再挪到那个工作区前面
 */
export function dropCommands(item: DragItem, target: DropTarget, deviceId: string): DropCommand[] {
  if (item.deviceId !== deviceId) return []
  if (item.kind === 'session') {
    const sessionId = item.id
    switch (target.kind) {
      case 'pinned':
        return item.pinned
          ? []
          : [{ name: 'session.place', params: { sessionId, place: 'pinned' } }]
      case 'section':
        return item.sectionId === target.sectionId
          ? []
          : [
              {
                name: 'session.place',
                params: { sessionId, place: { sectionId: target.sectionId } },
              },
            ]
      case 'workspace':
        return item.workspaceId === target.workspaceId && (item.pinned || item.sectionId)
          ? [{ name: 'session.place', params: { sessionId, place: null } }]
          : []
      case 'loose':
        return item.workspaceId === null && (item.pinned || item.sectionId)
          ? [{ name: 'session.place', params: { sessionId, place: null } }]
          : []
    }
  }
  const workspaceId = item.id
  switch (target.kind) {
    case 'pinned':
      return item.pinned
        ? []
        : [{ name: 'workspace.update', params: { workspaceId, pinned: true } }]
    case 'section':
      return item.sectionId === target.sectionId
        ? []
        : [{ name: 'workspace.update', params: { workspaceId, sectionId: target.sectionId } }]
    case 'workspace': {
      if (target.workspaceId === workspaceId) return []
      const out: DropCommand[] = []
      if (item.pinned)
        out.push({ name: 'workspace.update', params: { workspaceId, pinned: false } })
      if (item.sectionId) {
        out.push({ name: 'workspace.update', params: { workspaceId, sectionId: null } })
      }
      out.push({ name: 'workspace.move', params: { workspaceId, before: target.workspaceId } })
      return out
    }
    case 'loose':
      // 放回列表里，位置不动
      return item.pinned
        ? [{ name: 'workspace.update', params: { workspaceId, pinned: false } }]
        : item.sectionId
          ? [{ name: 'workspace.update', params: { workspaceId, sectionId: null } }]
          : []
  }
}

/** 拖放时带在 dataTransfer 上的类型。只用来认出是侧栏里拖出来的，内容在 current 里 */
export const DRAG_TYPE = 'application/x-litch-sidebar'

let current: DragItem | null = null
const listeners = new Set<() => void>()

/** 开始拖：记下拖的是什么，叫醒等着显示落点的地方 */
export function startDrag(item: DragItem): void {
  current = item
  for (const listener of listeners) listener()
}

/** 拖完了（放下、松手、拖出了窗口） */
export function endDrag(): void {
  if (current === null) return
  current = null
  for (const listener of listeners) listener()
}

export const draggedItem = (): DragItem | null => current

export function onDragChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
