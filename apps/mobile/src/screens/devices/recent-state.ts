// 「最近」组的快捷设置：收起、按项目聚合、默认显示几条。照桌面（packages/ui/src/sidebar/projection-state.ts）
// 记在本机，不经设备同步；手机自己存一份文件，桌面的那份在浏览器存储里。纯逻辑在 recent-settings.ts。
import { useSyncExternalStore } from 'react'
import { jsonFile } from '../../shell/json-file'
import { type RecentSettings, readRecentSettings } from './recent-settings'

export type ProjectionKind = 'recent' | 'unread'

// 「最近」「未读」各记一份（文件名沿用最近组原来那一份）
const files = {
  recent: jsonFile<RecentSettings>('recent-group.json'),
  unread: jsonFile<RecentSettings>('unread-group.json'),
}
const settings: Partial<Record<ProjectionKind, RecentSettings>> = {}
const listeners = new Set<() => void>()
const current = (kind: ProjectionKind): RecentSettings =>
  (settings[kind] ??= readRecentSettings(files[kind].read()))
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useRecentSettings = (kind: ProjectionKind = 'recent'): RecentSettings =>
  useSyncExternalStore(subscribe, () => current(kind))

export function setRecentSettings(
  change: Partial<RecentSettings>,
  kind: ProjectionKind = 'recent',
): void {
  const next = { ...current(kind), ...change }
  settings[kind] = next
  try {
    files[kind].write(next)
  } catch {
    /* 写不下去也照样用这一次的设置。 */
  }
  for (const listener of listeners) listener()
}
