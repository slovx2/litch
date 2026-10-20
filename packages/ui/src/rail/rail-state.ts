// 右边常驻的信息栏眼下把哪个会话的待办接过去了。对话区据此决定还要不要在回合里画待办卡片：
// 栏里有了就不在对话里再画一遍；栏放不下、收起来的时候，待办照旧回到对话里。
import { useSyncExternalStore } from 'react'

let shown: string | null = null
const listeners = new Set<() => void>()

/** 栏里接过去了哪个会话的待办（设备加会话），没有就是 null */
export function setRailTodo(sessionKey: string | null): void {
  if (shown === sessionKey) return
  shown = sessionKey
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 这个会话的待办是不是在信息栏里 */
export function useRailHasTodo(sessionKey: string): boolean {
  return useSyncExternalStore(subscribe, () => shown === sessionKey)
}

// ---------- 验收用：把信息栏整个关掉 ----------
// 对话区的滚动验收要量待办卡片在对话里更新时视口稳不稳，得让待办留在对话里（照 window.__litchLook 的做法）
let allowed = true
const allowListeners = new Set<() => void>()

declare global {
  interface Window {
    __litchRail?: { set(allowed: boolean): void }
  }
}

window.__litchRail = {
  set(next: boolean) {
    if (allowed === next) return
    allowed = next
    for (const listener of allowListeners) listener()
  },
}

/** 信息栏这会儿允不允许出来 */
function subscribeAllowed(listener: () => void): () => void {
  allowListeners.add(listener)
  return () => allowListeners.delete(listener)
}

export function useRailAllowed(): boolean {
  return useSyncExternalStore(subscribeAllowed, () => allowed)
}
