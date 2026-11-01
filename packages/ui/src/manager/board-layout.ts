// 桌面看板的宽度与开合属于本机布局；窗口变窄只压缩显示，不覆盖用户保存的宽度。
import { useSyncExternalStore } from 'react'

export const BOARD_MIN = 360
export const BOARD_MAX = 900
export const CHAT_MIN = 380
export const BOARD_GRIP = 6
export const BOARD_DEFAULT = 560
const KEY = 'litch.managerBoardLayout'
export const boardWidth = (width: number) =>
  Math.max(BOARD_MIN, Math.min(BOARD_MAX, Math.round(width)))
export const boardLimit = (room: number) =>
  Math.max(BOARD_MIN, Math.min(BOARD_MAX, room - CHAT_MIN - BOARD_GRIP))
export const shownBoardWidth = (width: number, room: number) =>
  Math.min(boardWidth(width), boardLimit(room))
interface Layout {
  open: boolean
  width: number
}
function read(): Layout {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return {
      open: value.open !== false,
      width:
        typeof value.width === 'number' && Number.isFinite(value.width)
          ? boardWidth(value.width)
          : BOARD_DEFAULT,
    }
  } catch {
    return { open: true, width: BOARD_DEFAULT }
  }
}
let state = read()
const listeners = new Set<() => void>()
export const boardLayoutNow = () => state
export function setBoardLayout(patch: Partial<Layout>) {
  state = { ...state, ...patch, width: boardWidth(patch.width ?? state.width) }
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
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
export const useBoardLayout = () => useSyncExternalStore(subscribe, boardLayoutNow)
