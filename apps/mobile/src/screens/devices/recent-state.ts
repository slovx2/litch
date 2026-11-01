// 「最近」组的快捷设置：收起、按项目聚合、默认显示几条。照桌面（packages/ui/src/sidebar/projection-state.ts）
// 记在本机，不经设备同步；手机自己存一份文件，桌面的那份在浏览器存储里。
import { useSyncExternalStore } from 'react'
import { jsonFile } from '../../shell/json-file'

export interface RecentSettings {
  collapsed: boolean
  byProject: boolean
  first: number
}

export const FIRST_CHOICES = [5, 10, 20] as const
/** “显示更多”每次多几条（和桌面一样） */
export const MORE_STEP = 10

export function readRecentSettings(value: unknown): RecentSettings {
  const source = value && typeof value === 'object' ? (value as Partial<RecentSettings>) : {}
  const first = FIRST_CHOICES.find((n) => n === source.first) ?? FIRST_CHOICES[0]
  return { collapsed: source.collapsed === true, byProject: source.byProject === true, first }
}

const file = jsonFile<RecentSettings>('recent-group.json')
let settings: RecentSettings | null = null
const listeners = new Set<() => void>()
const current = (): RecentSettings => (settings ??= readRecentSettings(file.read()))
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useRecentSettings = (): RecentSettings => useSyncExternalStore(subscribe, current)

export function setRecentSettings(change: Partial<RecentSettings>): void {
  settings = { ...current(), ...change }
  try {
    file.write(settings)
  } catch {
    /* 写不下去也照样用这一次的设置。 */
  }
  for (const listener of listeners) listener()
}
