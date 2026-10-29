// 页面上有没有挂着请求卡片（RequestCard 挂上时登记、卸下时撤销）。终端面板据此让出地方（dock.css 的 .term-dock[data-asking]）。
// 不用 `.main:has(.req-frame)` 在样式里判断：终端面板挂上之后，这种 :has 让主区域里任何节点的插入删除
// 都重算整片主区域的样式，长会话里打一个字要一两百毫秒，面板收起（只是藏起来）也不恢复
import { useEffect, useSyncExternalStore } from 'react'

let cards = 0
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function bump(by: number): void {
  const was = cards > 0
  cards += by
  if (cards > 0 !== was) for (const listener of listeners) listener()
}

/** 请求卡片挂着期间调：登记一张，卸下时撤销 */
export function useHoldAsking(): void {
  useEffect(() => {
    bump(1)
    return () => bump(-1)
  }, [])
}

/** 页面上有没有请求卡片 */
export function useAsking(): boolean {
  return useSyncExternalStore(subscribe, () => cards > 0)
}
