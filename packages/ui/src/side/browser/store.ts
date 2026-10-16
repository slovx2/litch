// 浏览器标签在界面这边的状态：外壳报来的全部标签、每个会话眼前看的是哪个、代理要给人看的是哪个。
// 全在内存里（标签本身在外壳那边，应用重开就没了）。挑哪个标签的规矩是纯函数（chooseTab），单独测
// （test/browser-store.test.mjs）。
import { useSyncExternalStore } from 'react'
import { type BrowserOwner, type BrowserTabInfo, browserBridge, ownerKey } from './bridge.ts'

/** 侧面板里浏览器标签的标识（tabs.ts 登记用） */
export const BROWSER_TAB = 'browser'

interface State {
  tabs: BrowserTabInfo[]
  /** 会话 → 人点选的标签 */
  chosen: Record<string, string>
  /** 会话 → 代理要给人看的标签（show 工具），看到之后清掉 */
  wanted: Record<string, string>
}

let state: State = { tabs: [], chosen: {}, wanted: {} }
const listeners = new Set<() => void>()
const publish = (next: State) => {
  state = next
  for (const listener of listeners) listener()
}

/** 这个会话的标签，按开的先后 */
export function tabsOf(tabs: readonly BrowserTabInfo[], owner: BrowserOwner): BrowserTabInfo[] {
  const key = ownerKey(owner)
  return tabs.filter((tab) => ownerKey(tab.owner) === key)
}

/**
 * 这个会话眼前显示哪个标签：代理要给人看的优先，其次是人点选的（还在的话），
 * 再次是代理正在用的，最后是最近开的那个
 */
export function chooseTab(
  mine: readonly BrowserTabInfo[],
  chosen: string | undefined,
  wanted: string | undefined,
): string | null {
  const has = (id: string | undefined) => id !== undefined && mine.some((tab) => tab.id === id)
  if (has(wanted)) return wanted as string
  if (has(chosen)) return chosen as string
  const busy = mine.filter((tab) => tab.agentActive).at(-1)
  if (busy) return busy.id
  return mine.at(-1)?.id ?? null
}

let started = false
/** 第一次用到时接上外壳的通知 */
function start(): void {
  if (started) return
  started = true
  const bridge = browserBridge()
  if (!bridge) return
  bridge.onState((tabs) => publish({ ...state, tabs }))
  void bridge.tabs().then((tabs) => publish({ ...state, tabs }))
}

const subscribe = (listener: () => void) => {
  start()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useBrowserState = (): State => useSyncExternalStore(subscribe, () => state)

/** 人点了一个标签 */
export function chooseBrowserTab(owner: BrowserOwner, tabId: string): void {
  const key = ownerKey(owner)
  const wanted = { ...state.wanted }
  delete wanted[key]
  publish({ ...state, chosen: { ...state.chosen, [key]: tabId }, wanted })
}

/** 代理要给人看这个标签 */
export function wantBrowserTab(tab: BrowserTabInfo): void {
  start()
  const key = ownerKey(tab.owner)
  publish({
    ...state,
    chosen: { ...state.chosen, [key]: tab.id },
    wanted: { ...state.wanted, [key]: tab.id },
  })
}
