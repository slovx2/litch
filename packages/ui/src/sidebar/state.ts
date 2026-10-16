// 侧栏自己的状态：开没开、多宽、是不是只看某几个 harness 的会话。
// 记在这台电脑的界面里（litch.sidebar），和外观、终端面板、侧面板一样不经核心。
// 这个文件不碰页面上的元素，只管数和存取：窗口窄的时候侧栏最宽能画多宽也在这里，好单独测。
import { useSyncExternalStore } from 'react'

export interface SidebarState {
  open: boolean
  /** 侧栏想要的宽度，像素。窗口不够宽的时候实际画出来的会更窄，这个数不跟着改 */
  width: number
  /** 只看哪几个 harness 的会话（它们的标识，按挑的先后）。空的：都看 */
  harnesses: readonly string[]
}

const NONE: readonly string[] = []

const STORAGE_KEY = 'litch.sidebar'
export const SIDEBAR_MIN = 240
export const SIDEBAR_MAX = 480
export const SIDEBAR_DEFAULT = 300
/**
 * 侧栏再宽，也要给右边（对话加侧面板）留这么多：正好是侧面板那边两样各让到底的宽度之和
 * （side/side.ts 的 MAIN_FLOOR 加 SIDE_FLOOR，测试里守着这两处一致）。
 * 窗口最窄是 900，所以最窄的窗口里侧栏最宽 300，输入框和侧面板不会被它挤得比各自的底线还窄
 */
export const REST_MIN = 600
/** 同一次按键可能从两条路各来一次（应用菜单的快捷键和页面自己的按键）：这么短时间里的第二次不算 */
const TOGGLE_GUARD_MS = 150

const within = (width: number): number =>
  Math.min(Math.max(Math.round(width), SIDEBAR_MIN), SIDEBAR_MAX)

function readSaved(): SidebarState {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<SidebarState>
    return {
      // 侧栏默认是开着的：只有明明白白记着“收起”才收
      open: parsed.open !== false,
      width:
        typeof parsed.width === 'number' && Number.isFinite(parsed.width)
          ? within(parsed.width)
          : SIDEBAR_DEFAULT,
      harnesses: Array.isArray(parsed.harnesses)
        ? [...new Set(parsed.harnesses.filter((id) => typeof id === 'string' && id !== ''))]
        : NONE,
    }
  } catch {
    // 读不到就用默认的：开着，默认宽度，都看
    return { open: true, width: SIDEBAR_DEFAULT, harnesses: NONE }
  }
}

let sidebar: SidebarState = readSaved()
// 还没开合过。不能写成 0：页面的钟是从打开页面那一刻走起的，见终端面板里同一处的说明
let lastToggle = Number.NEGATIVE_INFINITY
const listeners = new Set<() => void>()

const publish = (next: SidebarState) => {
  sidebar = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 记不下来不影响这一次
  }
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useSidebar = (): SidebarState => useSyncExternalStore(subscribe, () => sidebar)

export const sidebarNow = (): SidebarState => sidebar

/** 只要“只看哪几个 harness”这一项：拖宽、开合的时候用它的组件（各台设备的会话树）不跟着重画 */
export const useSidebarHarnesses = (): readonly string[] =>
  useSyncExternalStore(subscribe, () => sidebar.harnesses)

/** 换成只看这几个（空的是都看）。同一个标识只留一次 */
export function setSidebarHarnesses(harnesses: readonly string[]): void {
  const next = [...new Set(harnesses)]
  const same =
    next.length === sidebar.harnesses.length &&
    next.every((id, index) => id === sidebar.harnesses[index])
  if (!same) publish({ ...sidebar, harnesses: next.length === 0 ? NONE : next })
}

export function setSidebarOpen(open: boolean): void {
  if (sidebar.open !== open) publish({ ...sidebar, open })
}

/** 开着就收，收着就开 */
export function toggleSidebar(): void {
  const now = performance.now()
  if (now - lastToggle < TOGGLE_GUARD_MS) return
  lastToggle = now
  publish({ ...sidebar, open: !sidebar.open })
}

export function setSidebarWidth(width: number): void {
  const next = within(width)
  if (next !== sidebar.width) publish({ ...sidebar, width: next })
}

/** 窗口这么宽的时候，侧栏最宽能画多宽。再窄的窗口也不把它压到最窄以下：那时候让的是右边 */
export function widthLimit(windowWidth: number): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(windowWidth) - REST_MIN))
}

/** 实际画多宽：想要的宽度，夹在最窄和这个窗口里的最宽之间。拖动、键盘调宽度也用它把关 */
export function drawnWidth(wanted: number, windowWidth: number): number {
  return Math.min(Math.max(Math.round(wanted), SIDEBAR_MIN), widthLimit(windowWidth))
}

/**
 * 同一个算法写成样式：宽度交给浏览器跟着窗口算，窗口变宽变窄不用重画侧栏。
 * 和 drawnWidth 必须是一回事（界面测试和验收各守一头）
 */
export function widthCss(wanted: number): string {
  const limit = `max(${SIDEBAR_MIN}px, min(${SIDEBAR_MAX}px, 100vw - ${REST_MIN}px))`
  return `clamp(${SIDEBAR_MIN}px, ${Math.round(wanted)}px, ${limit})`
}
