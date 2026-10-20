// 侧面板（主区右边那一栏）自己的状态：开没开、多宽、看的是哪个标签。
// 开没开按会话记：在 A 会话里打开了，切到没打开过的 B 是收着的，切回 A 又开着（新建对话页按设备记）。
// 宽度和标签是大家共用的。都记在这台电脑的界面里（litch.side），和外观、终端面板一样不经核心。
// 这个文件不碰页面上的元素，只管数和存取：窄窗口里怎么让位（layoutOf）也在这里，好单独测。
import { useSyncExternalStore } from 'react'

export interface SideState {
  /** 眼前这个会话里面板开没开 */
  open: boolean
  /** 面板想要的宽度，像素。窗口不够宽的时候实际画出来的会更窄，这个数不跟着改 */
  width: number
  /** 看的是哪个标签（标签登记表里的标识）。登记表里没有它了就看第一个 */
  tab: string
  /** 人打开面板的次数（按钮、快捷键、别处要“在侧面板里看这个”）。切会话带出来的打开不算，面板只在它变了的时候抢焦点 */
  raised: number
}

const STORAGE_KEY = 'litch.side'
/** 最多记这么多个会话开着面板，超出时丢掉最早打开的 */
const OPENED_LIMIT = 200
export const SIDE_MIN = 360
export const SIDE_DEFAULT = 500
/** 窗口够宽的时候，左边的对话至少留这么宽 */
export const MAIN_MIN = 380
/**
 * 窗口窄到上面两样凑不齐的时候，两边一起让，各让到这里为止：对话 320、面板 280。
 * 窗口最窄是 900，侧栏 300，剩下的 600 正好是这两个数。面板一直和对话并排，不盖在对话上面：
 * 输入框和请求卡片不能被它挡住
 */
export const MAIN_FLOOR = 320
export const SIDE_FLOOR = 280
/** 同一次按键可能从两条路各来一次（应用菜单的快捷键和页面自己的按键）：这么短时间里的第二次不算 */
const TOGGLE_GUARD_MS = 150

interface Saved {
  width: number
  tab: string
  /** 开着面板的那些会话（viewKey），最近打开的排在最后 */
  opened: string[]
}

function readSaved(): Saved {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Saved>
    return {
      width:
        typeof parsed.width === 'number' && Number.isFinite(parsed.width)
          ? Math.max(SIDE_MIN, Math.round(parsed.width))
          : SIDE_DEFAULT,
      tab: typeof parsed.tab === 'string' ? parsed.tab : '',
      opened: Array.isArray(parsed.opened)
        ? parsed.opened.filter((key): key is string => typeof key === 'string' && key !== '')
        : [],
    }
  } catch {
    // 读不到就用默认的：都收着，默认宽度
    return { width: SIDE_DEFAULT, tab: '', opened: [] }
  }
}

const saved = readSaved()
/** 开着面板的会话 */
const opened = new Set(saved.opened)
/** 眼前看的是哪个会话（viewKey）。空的：眼前不是会话，也不是新建对话页 */
let viewing = ''
let side: SideState = { open: false, width: saved.width, tab: saved.tab, raised: 0 }
// 还没开合过。不能写成 0：页面的钟是从打开页面那一刻走起的，见终端面板里同一处的说明
let lastToggle = Number.NEGATIVE_INFINITY
const listeners = new Set<() => void>()

const publish = (next: SideState) => {
  side = next
  try {
    const record: Saved = { width: next.width, tab: next.tab, opened: [...opened] }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record))
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

export const useSide = (): SideState => useSyncExternalStore(subscribe, () => side)

export const sideNow = (): SideState => side

/** 面板记在哪个会话名下：会话是“设备:会话”，新建对话页是“new:设备” */
export const viewKey = (deviceId: string, sessionId: string | null): string =>
  sessionId ? `${deviceId}:${sessionId}` : `new:${deviceId}`

/** 换了眼前的会话：面板照那个会话自己记着的开合。这不算人打开的，不抢焦点 */
export function setSideView(key: string): void {
  if (viewing === key) return
  viewing = key
  const open = key !== '' && opened.has(key)
  if (side.open !== open) {
    side = { ...side, open }
    for (const listener of listeners) listener()
  }
}

/** 人在眼前这个会话里开或收面板 */
function setOpen(open: boolean): void {
  if (side.open === open) return
  if (viewing !== '') {
    opened.delete(viewing)
    if (open) opened.add(viewing)
    while (opened.size > OPENED_LIMIT) {
      const oldest = opened.values().next().value
      if (oldest === undefined) break
      opened.delete(oldest)
    }
  }
  publish({ ...side, open, raised: open ? side.raised + 1 : side.raised })
}

export function setSideOpen(open: boolean): void {
  setOpen(open)
}

/** 开着就收，收着就开 */
export function toggleSide(): void {
  const now = performance.now()
  if (now - lastToggle < TOGGLE_GUARD_MS) return
  lastToggle = now
  setOpen(!side.open)
}

export function setSideWidth(width: number): void {
  const next = Math.max(SIDE_MIN, Math.round(width))
  if (next !== side.width) publish({ ...side, width: next })
}

export function setSideTab(tab: string): void {
  if (side.tab !== tab) publish({ ...side, tab })
}

/** 打开面板并且换到某个标签。别处要“在侧面板里看这个”的时候用 */
export function showSideTab(tab: string): void {
  if (side.tab !== tab) publish({ ...side, tab })
  setOpen(true)
}

export interface SideLayout {
  /**
   * docked：窗口够宽，对话留够了 MAIN_MIN，面板在 SIDE_MIN 和想要的宽度之间；
   * tight：窗口窄，两边都比平时的最窄还窄了。还是并排，只是面板里的内容要换个排法（文件标签改成上下摆）
   */
  mode: 'docked' | 'tight'
  /** 实际画多宽 */
  width: number
}

/**
 * 面板画多宽。room 是侧栏右边一共多宽（对话加面板）。
 * 放得下就照想要的来：对话至少留 MAIN_MIN，面板不比 SIDE_MIN 窄；
 * 放不下的时候两边按比例一起让，从（MAIN_MIN，SIDE_MIN）让到（MAIN_FLOOR，SIDE_FLOOR）为止，中间是连着的，不跳。
 */
export function layoutOf(wanted: number, room: number): SideLayout {
  const most = room - MAIN_MIN
  if (most >= SIDE_MIN) {
    return { mode: 'docked', width: Math.round(Math.min(Math.max(wanted, SIDE_MIN), most)) }
  }
  const from = MAIN_FLOOR + SIDE_FLOOR
  const share = (room - from) / (MAIN_MIN + SIDE_MIN - from)
  const width = SIDE_FLOOR + (SIDE_MIN - SIDE_FLOOR) * Math.min(Math.max(share, 0), 1)
  return { mode: 'tight', width: Math.round(width) }
}

/** 拖到这个宽度行不行：不能把对话挤得比 MAIN_MIN 还窄，也不能比 SIDE_MIN 还窄。窗口窄的时候宽度不由人拖 */
export function clampWidth(width: number, room: number): number {
  const most = Math.max(SIDE_MIN, room - MAIN_MIN)
  return Math.round(Math.min(Math.max(width, SIDE_MIN), most))
}
