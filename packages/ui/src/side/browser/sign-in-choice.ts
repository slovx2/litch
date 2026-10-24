// 登录卡片上“我自己登录”只是界面里换个样子（换成“完成，交还 / 取消”那一版），不告诉主进程：
// 标签本来就在人手里。浏览器面板和对话里那两张是同一张，选了之后两处一起换，所以记在这里共用。
import { useSyncExternalStore } from 'react'

let chosen: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

const publish = (next: ReadonlySet<string>) => {
  chosen = next
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 这张卡片（主进程登记的编号）选了自己登录，或者又换回用已存账号 */
export function chooseSelf(id: string, self: boolean): void {
  if (chosen.has(id) === self) return
  const next = new Set(chosen)
  if (self) next.add(id)
  else next.delete(id)
  publish(next)
}

export const useChoseSelf = (id: string): boolean =>
  useSyncExternalStore(subscribe, () => chosen.has(id))
