// 差异标签自己的界面状态：看哪种范围、选中哪个文件、树里收起了哪些目录、搜的是什么（按地方记，这次运行里一直留着），
// 并排还是合并、折不折行（记在这台电脑上，litch.diff）。还有“别处要在差异里看某个文件”的那一下。
// 不碰页面上的元素，只管数和存取。
import type { DiffScope } from '@litch/core'
import { useSyncExternalStore } from 'react'
import { showSideTab } from '../side/side.ts'

/** 这个标签的标识。和登记表（side/tabs.ts 的 DIFF_TAB）里是同一个字 */
export const DIFF_TAB = 'diff'

export interface DiffPrefs {
  /** 并排还是合并。地方窄的时候不管这个，一律合并 */
  layout: 'split' | 'unified'
  wrap: boolean
}

export interface PlaceState {
  scope: DiffScope
  /** 选中的文件（相对于根）。一次只看一个文件时看的就是它；接成一长条时是滚到了的那个 */
  picked: string | null
  /** 树里收起来的目录 */
  closed: ReadonlySet<string>
  query: string
}

const STORAGE_KEY = 'litch.diff'
const DEFAULT_PLACE: PlaceState = { scope: 'all', picked: null, closed: new Set(), query: '' }

function readPrefs(): DiffPrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<DiffPrefs>
    return { layout: parsed.layout === 'unified' ? 'unified' : 'split', wrap: parsed.wrap === true }
  } catch {
    return { layout: 'split', wrap: false }
  }
}

let prefs: DiffPrefs = readPrefs()
const places = new Map<string, PlaceState>()
/** 别处要定位到的文件。nonce 每要一次变一次 */
let wanted: { path: string; nonce: number } | null = null
let version = 0
const listeners = new Set<() => void>()

const publish = () => {
  version++
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const placeKey = (deviceId: string, root: string): string => `${deviceId}\n${root}`

export const useDiffPrefs = (): DiffPrefs => useSyncExternalStore(subscribe, () => prefs)

export function setDiffPrefs(patch: Partial<DiffPrefs>): void {
  prefs = { ...prefs, ...patch }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // 记不下来不影响这一次
  }
  publish()
}

export const placeNow = (key: string): PlaceState => places.get(key) ?? DEFAULT_PLACE

export function usePlaceState(key: string): PlaceState {
  useSyncExternalStore(subscribe, () => version)
  return placeNow(key)
}

export function setPlaceState(key: string, patch: Partial<PlaceState>): void {
  places.set(key, { ...placeNow(key), ...patch })
  publish()
}

export function toggleDir(key: string, path: string): void {
  const closed = new Set(placeNow(key).closed)
  if (!closed.delete(path)) closed.add(path)
  setPlaceState(key, { closed })
}

/** 别处（对话里的“改了文件”）要在差异里看这个文件：打开侧面板、换到差异标签、定位到它 */
export function openDiffAt(path: string | null): void {
  if (path !== null) wanted = { path, nonce: (wanted?.nonce ?? 0) + 1 }
  publish()
  showSideTab(DIFF_TAB)
}

export const useWanted = (): { path: string; nonce: number } | null =>
  useSyncExternalStore(subscribe, () => wanted)
