// 侧栏里的拖放：拖的是什么、放到哪、放下去做什么。纯函数，界面在 Sidebar.tsx 里接上。
// 能拖的是会话和工作区（项目）；能放的是置顶、组、内置的“项目”组、工作区那一行、“无项目”。
// 会话只能拖进置顶、组，或者拖回它自己所在的工作区（就是从置顶、组里拿出来）：
// 这一版不支持把会话拖到另一个工作区（菜单里的“移到项目”还在）。会话在组里没有可调的顺序，所以只有“放进”。
// 工作区总在某一组里（置顶、用户建的组，或者“项目”），既能放进一组（排到最后），也能插到一组里两个工作区之间。
// 用户建的组和“项目”自己也能拖（拖标题行）：插到别的组前面、后面，先后只记在这台电脑上（state.ts 的 bands）。

/** 正在拖的东西。拖的时候记着，放下或者松手就清掉 */
export interface DragItem {
  deviceId: string
  /** band 是一整组（用户建的组、“项目”），id 是组的键 */
  kind: 'session' | 'workspace' | 'band'
  id: string
  /** 会话所属的工作区；拖的是工作区时是它自己，拖的是组时是 null */
  workspaceId: string | null
  pinned: boolean
  /** 在哪个组里。不在是 null */
  sectionId: string | null
}

/**
 * 工作区所在的一组：置顶、用户建的组，或者内置的“项目”。
 * “项目”只是界面上的叫法：设备上没有这一组，不在置顶、也不在用户组里的工作区都算在里面
 */
export type Band =
  | { kind: 'pinned' }
  | { kind: 'section'; sectionId: string }
  | { kind: 'projects' }

/** 放的地方 */
export type DropTarget =
  /** 放进这一组：拖到组的标题行上（或者组里没有别的落点接住的地方）。工作区排到这一组的最后 */
  | Band
  /** 插到一组里 before 这个工作区前面，null 是这一组的最后。只有拖工作区时有 */
  | { kind: 'slot'; band: Band; before: string | null }
  /** 工作区那一行：会话拖回自己的项目 */
  | { kind: 'workspace'; workspaceId: string }
  /** “无项目”那一组 */
  | { kind: 'loose' }
  /** 拖着一组停在 key 这一组上：插到它前面（after 为假）或者后面。只有拖组时有，见 bandsAfter */
  | { kind: 'band'; key: string; after: boolean }

/** 排工作区要知道的：设备上的顺序（整张表）和各自在哪一组 */
export interface Placed {
  id: string
  pinned: boolean
  sectionId: string | null
}

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

/** 这个工作区在哪一组。置顶和进组只能有一样（设备上保证） */
export const bandOf = (entry: { pinned: boolean; sectionId: string | null }): Band =>
  entry.pinned
    ? { kind: 'pinned' }
    : entry.sectionId
      ? { kind: 'section', sectionId: entry.sectionId }
      : { kind: 'projects' }

export const sameBand = (a: Band, b: Band): boolean =>
  a.kind === b.kind && (a.kind !== 'section' || a.sectionId === (b as typeof a).sectionId)

/**
 * 这样东西放到这里要做的事。放不了、或者放下去什么都不变是空数组（界面据此不让放）。
 * order 是这台设备上全部工作区（按设备上的顺序），排工作区的位置要用
 */
export function dropCommands(
  item: DragItem,
  target: DropTarget,
  deviceId: string,
  order: readonly Placed[] = [],
): DropCommand[] {
  // 组的先后不经设备（bandsAfter）
  if (item.deviceId !== deviceId || item.kind === 'band') return []
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
      // 会话不归“项目”组管（它跟着自己的工作区走），也没有可插的位置
      case 'projects':
      case 'slot':
      case 'band':
        return []
    }
  }
  switch (target.kind) {
    case 'workspace':
    case 'loose':
    case 'band':
      return []
    case 'slot':
      return placeWorkspace(item, target.band, target.before, order)
    default:
      return placeWorkspace(item, target, null, order)
  }
}

/**
 * 拖着工作区停在一组里的某个工作区上：after 为假是插到它前面，为真是插到它后面
 * （也就是这一组里下一个的前面，它是最后一个就是这一组的最后）。siblings 是这一组里画出来的工作区，按顺序
 */
export function slotOf(
  band: Band,
  workspaceId: string,
  after: boolean,
  siblings: readonly string[],
): DropTarget {
  if (!after) return { kind: 'slot', band, before: workspaceId }
  return { kind: 'slot', band, before: siblings[siblings.indexOf(workspaceId) + 1] ?? null }
}

/**
 * 工作区放进 band 这一组、排在 before 前面（null：这一组的最后）。
 * 换了组先改它在哪一组（进组、置顶、或者拿出来回到“项目”），再挪位置。
 * 设备上的顺序是整张表的：插到组的最后，就是挪到这一组最后一个在整张表里的下一个前面
 */
function placeWorkspace(
  item: DragItem,
  band: Band,
  before: string | null,
  order: readonly Placed[],
): DropCommand[] {
  const workspaceId = item.id
  const from = bandOf(item)
  const staying = sameBand(from, band)
  if (staying) {
    // 同一组里落下去还是原来的位置：什么都不做
    const inBand = order.filter((entry) => sameBand(bandOf(entry), band))
    const next = inBand[inBand.findIndex((entry) => entry.id === workspaceId) + 1]?.id ?? null
    if (before === workspaceId || before === next) return []
  }
  const rest = order.filter((entry) => entry.id !== workspaceId)
  const last = rest.filter((entry) => sameBand(bandOf(entry), band)).at(-1)
  /** 挪到谁前面。undefined：不用挪（放进一个空的组，在整张表里的位置无所谓） */
  const anchor =
    before !== null ? before : last ? (rest[rest.indexOf(last) + 1]?.id ?? null) : undefined
  const out: DropCommand[] = []
  if (!staying) {
    out.push({
      name: 'workspace.update',
      params:
        band.kind === 'pinned'
          ? { workspaceId, pinned: true }
          : band.kind === 'section'
            ? { workspaceId, sectionId: band.sectionId }
            : from.kind === 'pinned'
              ? { workspaceId, pinned: false }
              : { workspaceId, sectionId: null },
    })
  }
  if (anchor !== undefined) {
    out.push({ name: 'workspace.move', params: { workspaceId, before: anchor } })
  }
  return out
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

/**
 * 组的先后：记着的顺序里还在的照记着的排，没记过的（新建的组）按设备给的先后接在后面。
 * present 是现在有的组，按默认的先后（用户的组按设备给的、“项目”在最后）
 */
export function orderBands(
  saved: readonly string[] | undefined,
  present: readonly string[],
): string[] {
  const kept = (saved ?? []).filter((key) => present.includes(key))
  return [...kept, ...present.filter((key) => !kept.includes(key))]
}

/**
 * 拖着 key 这一组停在 target 这一组上：after 为假插到它前面，为真插到它后面。
 * 返回新的先后；放不了（拖的不在里面、停在自己上）或者落下去还是原处是 null
 */
export function bandsAfter(
  order: readonly string[],
  key: string,
  target: string,
  after: boolean,
): string[] | null {
  if (key === target || !order.includes(key) || !order.includes(target)) return null
  const rest = order.filter((entry) => entry !== key)
  const at = rest.indexOf(target) + (after ? 1 : 0)
  const next = [...rest.slice(0, at), key, ...rest.slice(at)]
  return next.every((entry, index) => entry === order[index]) ? null : next
}
