// 侧面板“后台任务”页的标识、开合，和页上正看着哪一行（按父会话记）。
// 这个文件不碰界面的服务（侧面板的标签登记表、对话里的子代理卡片都要引它）
import { useSyncExternalStore } from 'react'
import { setSideOpen, showSideTab, sideNow } from '../side/side.ts'

export const BACKGROUND_TAB = 'background'

/** 输入框上方那一行点了：右侧“后台任务”页开着就收起，没开就打开 */
export function toggleBackgroundTab(): void {
  const side = sideNow()
  if (side.open && side.tab === BACKGROUND_TAB) setSideOpen(false)
  else showSideTab(BACKGROUND_TAB)
}

const keyOf = (deviceId: string, parentId: string) => `${deviceId}:${parentId}`

/** 父会话 → 页上选中的那一行（BackgroundEntryView.key）。没选是列表本身 */
const picked = new Map<string, string>()
let version = 0
const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const publish = () => {
  version++
  for (const listener of listeners) listener()
}

/** 选中一行（null：回到只有列表） */
export function pickBackground(deviceId: string, parentId: string, key: string | null): void {
  if (key === null) picked.delete(keyOf(deviceId, parentId))
  else picked.set(keyOf(deviceId, parentId), key)
  publish()
}

export function usePickedBackground(deviceId: string, parentId: string | null): string | null {
  useSyncExternalStore(subscribe, () => version)
  return parentId === null ? null : (picked.get(keyOf(deviceId, parentId)) ?? null)
}

/** 在右侧“后台任务”页里看父会话的这个子代理（对话里的子代理卡片、信息卡点了） */
export function openAgent(deviceId: string, parentId: string, threadId: string): void {
  pickBackground(deviceId, parentId, `agent:${threadId}`)
  showSideTab(BACKGROUND_TAB)
}
