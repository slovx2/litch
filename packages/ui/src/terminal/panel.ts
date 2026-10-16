// 终端面板自己的状态：开没开、多高、每一组里看的是哪个标签。
// 开合和高度记在这台电脑的界面里（litch.terminal），和外观一样不经核心；看的是哪个标签只在这次运行里有效。
import { useSyncExternalStore } from 'react'

export interface PanelState {
  open: boolean
  /** 面板的高度，像素 */
  height: number
}

const STORAGE_KEY = 'litch.terminal'
export const PANEL_MIN = 120
export const PANEL_DEFAULT = 260
/** 面板再高也要给上面的对话留这么多 */
const ABOVE_MIN = 160
/** 同一次按键可能从两条路各来一次（应用菜单的快捷键和页面自己的按键）：这么短时间里的第二次不算 */
const TOGGLE_GUARD_MS = 150

function readSaved(): PanelState {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<PanelState>
    return {
      open: parsed.open === true,
      height:
        typeof parsed.height === 'number' && Number.isFinite(parsed.height)
          ? Math.max(PANEL_MIN, Math.round(parsed.height))
          : PANEL_DEFAULT,
    }
  } catch {
    // 读不到就用默认的：收着，默认高度
    return { open: false, height: PANEL_DEFAULT }
  }
}

let panel: PanelState = readSaved()
// 还没开合过。不能写成 0：页面的钟是从打开页面那一刻走起的，写成 0 的话打开页面之后头 150 毫秒里的那一次会被当成重复的吃掉
let lastToggle = Number.NEGATIVE_INFINITY
const listeners = new Set<() => void>()

const publish = (next: PanelState) => {
  panel = next
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

export const usePanel = (): PanelState => useSyncExternalStore(subscribe, () => panel)

export const panelNow = (): PanelState => panel

export function setPanelOpen(open: boolean): void {
  if (panel.open !== open) publish({ ...panel, open })
}

/** 开着就收，收着就开 */
export function togglePanel(): void {
  const now = performance.now()
  if (now - lastToggle < TOGGLE_GUARD_MS) return
  lastToggle = now
  publish({ ...panel, open: !panel.open })
}

/** room：面板所在的那一栏一共多高。面板不能把上面的对话挤没 */
export function clampHeight(height: number, room: number): number {
  const most = Math.max(PANEL_MIN, room - ABOVE_MIN)
  return Math.round(Math.min(Math.max(height, PANEL_MIN), most))
}

export function setPanelHeight(height: number): void {
  const next = Math.max(PANEL_MIN, Math.round(height))
  if (next !== panel.height) publish({ ...panel, height: next })
}

// ---------- 每一组里看的是哪个标签 ----------

const picked = new Map<string, string>()
const pickListeners = new Set<() => void>()
let pickVersion = 0

const subscribePicks = (listener: () => void) => {
  pickListeners.add(listener)
  return () => {
    pickListeners.delete(listener)
  }
}

/** 一组的标识：哪台设备上的哪个工作区（或者“无工作区”） */
export const groupKey = (deviceId: string, group: string): string => `${deviceId}\n${group}`

export function pickTab(key: string, terminalId: string): void {
  if (picked.get(key) === terminalId) return
  picked.set(key, terminalId)
  pickVersion++
  for (const listener of pickListeners) listener()
}

/** 这一组里上次看的是哪个。没看过就是 undefined */
export function usePickedTab(key: string): string | undefined {
  useSyncExternalStore(subscribePicks, () => pickVersion)
  return picked.get(key)
}
