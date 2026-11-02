// 「最近」组的快捷设置：收起、按项目聚合、默认显示几条。照桌面（packages/ui/src/sidebar/projection-state.ts）
// 记在本机，不经设备同步；手机自己存一份文件，桌面的那份在浏览器存储里。纯逻辑在 recent-settings.ts。
import { useSyncExternalStore } from 'react'
import { jsonFile } from '../../shell/json-file'
import { type RecentSettings, readRecentSettings } from './recent-settings'

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
