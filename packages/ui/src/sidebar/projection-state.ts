import type { SidebarProjectionKind } from '@litch/core'
import { useSyncExternalStore } from 'react'

export interface ProjectionSettings {
  collapsed: boolean
  byProject: boolean
  first: number
}
type Settings = Record<SidebarProjectionKind, ProjectionSettings>
const STORAGE = 'litch.sidebar.projections'

export function readProjectionSettings(value: unknown): Settings {
  const source = value && typeof value === 'object' ? (value as Partial<Settings>) : {}
  const one = (kind: SidebarProjectionKind): ProjectionSettings => ({
    collapsed: source[kind]?.collapsed === true,
    byProject: source[kind]?.byProject === true,
    first: [5, 10, 20].includes(source[kind]?.first ?? 0) ? (source[kind]?.first ?? 5) : 5,
  })
  return { unread: one('unread'), recent: one('recent') }
}
let settings = readProjectionSettings(null)
try {
  settings = readProjectionSettings(JSON.parse(localStorage.getItem(STORAGE) ?? 'null'))
} catch {
  /* 禁止本地存储时仍可使用。 */
}
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const useProjectionSettings = (kind: SidebarProjectionKind): ProjectionSettings =>
  useSyncExternalStore(subscribe, () => settings[kind])
export function setProjectionSettings(
  kind: SidebarProjectionKind,
  change: Partial<ProjectionSettings>,
): void {
  settings = { ...settings, [kind]: { ...settings[kind], ...change } }
  try {
    localStorage.setItem(STORAGE, JSON.stringify(settings))
  } catch {
    /* 禁止本地存储时仍可使用。 */
  }
  for (const listener of listeners) listener()
}
