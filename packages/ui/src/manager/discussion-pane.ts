// 控制台的帖子讨论不内嵌在卡片里：卡片标题行只留一个讨论入口，点开后在看板底部分屏显示。
// 讨论组件仍挂在各自卡片下（草稿、追问目标、提交都留在原处），只把入口和内容用 portal 挂到卡片标题行和分屏里。
import { createContext, useContext, useSyncExternalStore } from 'react'

export interface DiscussionPaneValue {
  /** 分屏里放讨论内容的节点；分屏没开时为 null */
  host: HTMLElement | null
  /** 当前打开讨论的帖子 */
  openId: string | null
  open(id: string): void
  /** 只关自己：别的帖子已经接过分屏时不动 */
  close(id?: string): void
}
/** 看板提供；没有看板的地方（全局“建议”窗口）为 null，讨论照旧内嵌在卡片里 */
export const DiscussionPaneContext = createContext<DiscussionPaneValue | null>(null)
export const useDiscussionPane = () => useContext(DiscussionPaneContext)

/** 卡片标题行里放讨论入口的插槽（PostCard 提供） */
export const DiscussionSlotContext = createContext<HTMLElement | null>(null)
export const useDiscussionSlot = () => useContext(DiscussionSlotContext)

// 分屏高度属于本机布局，和看板宽度一样记在本机
export const PANE_MIN = 160
export const PANE_DEFAULT = 320
/** 上面的卡片列表至少留这么高 */
export const PANE_LIST_MIN = 140
const KEY = 'litch.managerDiscussionPane'
const clampHeight = (height: number) => Math.max(PANE_MIN, Math.round(height))
function read(): number {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return typeof value.height === 'number' && Number.isFinite(value.height)
      ? clampHeight(value.height)
      : PANE_DEFAULT
  } catch {
    return PANE_DEFAULT
  }
}
let height = read()
const listeners = new Set<() => void>()
export const paneHeightNow = () => height
export function setPaneHeight(next: number) {
  height = clampHeight(next)
  try {
    localStorage.setItem(KEY, JSON.stringify({ height }))
  } catch {
    /* 不能持久化时仍允许调整本窗口。 */
  }
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const usePaneHeight = () => useSyncExternalStore(subscribe, paneHeightNow)
