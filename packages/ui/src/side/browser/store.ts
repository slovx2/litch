// 浏览器标签在界面这边的状态：外壳报来的全部标签、每个会话眼前看的是哪个、代理要给人看的是哪个。
// 全在内存里（标签本身在外壳那边，应用重开就没了）。挑哪个标签的规矩是纯函数（chooseTab），单独测
// （test/browser-store.test.mjs）。
//
// 代理调 show 要给人看一个网页时，不把用户从眼前的会话拽走：用户正看着那个会话（侧面板这时显示得出来），
// 就打开面板换到浏览器标签；看着别的会话、或者在设置这类页面上，就先记在那个会话名下（pending），
// 侧栏那一行出一个小记号，另出一条提示可以点过去；用户切到那个会话时再打开面板。
// 记着的标签被关掉（回合结束收掉了代理的临时标签）就不再算数。规矩是纯函数（noteShow、arrive、prunePending）。
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
  /** 会话 → 代理要给人看、但用户当时没看着这个会话的标签。用户切过来时变成 wanted 并打开面板 */
  pending: Record<string, string>
}

export const EMPTY_STATE: State = { tabs: [], chosen: {}, wanted: {}, pending: {} }
let state: State = EMPTY_STATE
/** 眼前看着的会话（ownerKey；新建对话页上会话标识是空的），侧面板显示不出来的时候（设置这类页面）是 null */
let viewing: string | null = null
/** 同一个会话，原样记着（对话里的链接要用它开标签） */
let viewingOwner: BrowserOwner | null = null
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

const without = (record: Record<string, string>, key: string): Record<string, string> => {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

/** 标签的最新样子并进清单（show 带来的可能比清单新） */
const upsert = (tabs: readonly BrowserTabInfo[], tab: BrowserTabInfo): BrowserTabInfo[] =>
  tabs.some((one) => one.id === tab.id)
    ? tabs.map((one) => (one.id === tab.id ? tab : one))
    : [...tabs, tab]

/**
 * 代理要给人看 tab（show）：用户眼前就是这个会话，记成要看的并打开面板（open）；不是的话记进 pending，
 * 等用户切过来
 */
export function noteShow(
  current: State,
  tab: BrowserTabInfo,
  viewingKey: string | null,
): { state: State; open: boolean } {
  const key = ownerKey(tab.owner)
  const tabs = upsert(current.tabs, tab)
  if (key === viewingKey) {
    return {
      state: {
        ...current,
        tabs,
        chosen: { ...current.chosen, [key]: tab.id },
        wanted: { ...current.wanted, [key]: tab.id },
        pending: without(current.pending, key),
      },
      open: true,
    }
  }
  return {
    state: { ...current, tabs, pending: { ...current.pending, [key]: tab.id } },
    open: false,
  }
}

/** 用户切到了 viewingKey 这个会话：它名下有还在的 pending，就变成要看的并打开面板 */
export function arrive(current: State, viewingKey: string | null): { state: State; open: boolean } {
  if (viewingKey === null) return { state: current, open: false }
  const tabId = current.pending[viewingKey]
  if (tabId === undefined) return { state: current, open: false }
  const pending = without(current.pending, viewingKey)
  if (!current.tabs.some((tab) => tab.id === tabId))
    return { state: { ...current, pending }, open: false }
  return {
    state: {
      ...current,
      pending,
      chosen: { ...current.chosen, [viewingKey]: tabId },
      wanted: { ...current.wanted, [viewingKey]: tabId },
    },
    open: true,
  }
}

/** 标签清单变了：pending 里已经关掉的标签不再算数 */
export function prunePending(
  pending: Record<string, string>,
  tabs: readonly BrowserTabInfo[],
): Record<string, string> {
  const alive = new Set(tabs.map((tab) => tab.id))
  const kept = Object.entries(pending).filter(([, tabId]) => alive.has(tabId))
  return kept.length === Object.keys(pending).length ? pending : Object.fromEntries(kept)
}

let started = false
/** 第一次用到时接上外壳的通知 */
function start(): void {
  if (started) return
  started = true
  const bridge = browserBridge()
  if (!bridge) return
  const take = (tabs: BrowserTabInfo[]) =>
    publish({ ...state, tabs, pending: prunePending(state.pending, tabs) })
  bridge.onState(take)
  void bridge.tabs().then(take)
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

const pendingListeners = new Set<(tab: BrowserTabInfo) => void>()

/** 代理要给人看的网页记在了别的会话名下（用户没看着那个会话）：出提示用 */
export function onPendingShow(listener: (tab: BrowserTabInfo) => void): () => void {
  pendingListeners.add(listener)
  return () => {
    pendingListeners.delete(listener)
  }
}

/** 外壳报来 show：回 true 是该打开面板换到浏览器标签了（用户眼前就是这个会话） */
export function routeShow(tab: BrowserTabInfo): boolean {
  start()
  const { state: next, open } = noteShow(state, tab, viewing)
  publish(next)
  if (!open) for (const listener of pendingListeners) listener(tab)
  return open
}

/** 眼前看着的会话换了（侧面板显示不出来时给 null）。回 true 是它名下有要看的网页，该打开面板了 */
export function setViewing(owner: BrowserOwner | null): boolean {
  viewing = owner ? ownerKey(owner) : null
  viewingOwner = owner
  const { state: next, open } = arrive(state, viewing)
  if (next !== state) publish(next)
  return open
}

/** 眼前看着的会话；侧面板显示不出来的页面上是 null */
export const viewingNow = (): BrowserOwner | null => viewingOwner

/** 只听状态的变化，不为此去接外壳（侧栏每一行都要听，没人 show 过就没什么可听的） */
const subscribeQuietly = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 侧栏一行用：这个会话名下有没有代理要给人看、还没看的网页。只在答案变了时重画 */
export function useBrowserWants(deviceId: string, sessionId: string): boolean {
  const key = ownerKey({ deviceId, threadId: sessionId })
  return useSyncExternalStore(subscribeQuietly, () => state.pending[key] !== undefined)
}
