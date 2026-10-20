// 标签和自动填充的预加载：用户开的、代理开的标签都挂（各个框架都跑一份，好让跨源子框架按它自己的源填；
// 代理的标签平时不填，交给人登录时才填，保存提示两种都有）。
// electron-tab.mts 建视图时用这里的两样：网页设置里加的预加载，和登记“这是哪种标签、怎么取它的样子”。
// 主进程收到自动填充、保存提示的消息先查登记（autofill.mts），没登记过的一律不认。
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WebContents, WebPreferences } from 'electron'
import type { TabInfo, TabKind } from '../model.mjs'

/** 和主进程的产物在同一个目录（scripts/build.mjs 打出来的） */
const PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'autofill-preload.cjs')

export interface AutofillTab {
  kind: TabKind
  /** 标签现在的样子（编号、归哪个会话） */
  info(): TabInfo
}

const tabs = new Map<number, AutofillTab>()
/** 交给人登录、还没交还的代理标签（passwords/handover.mts 管） */
const handedOver = new Set<number>()
/** 交给人登录期间网页开的弹窗（开成用户的标签）：开它的标签的 webContents 编号 → 弹窗的标签编号 */
const popups = new Map<number, Set<string>>()

/**
 * 标签多出来的网页设置。nodeIntegrationInSubFrames 在开了沙箱的视图上只是让预加载也在子框架里跑，
 * 不会给任何框架 Node；预加载在隔离环境里，网页碰不到它
 */
export function autofillPreferences(): WebPreferences {
  return { preload: PRELOAD, nodeIntegrationInSubFrames: true }
}

/** 建好视图之后登记；视图销毁时自己撤掉 */
export function registerAutofillTab(contents: WebContents, tab: AutofillTab): void {
  const id = contents.id
  tabs.set(id, tab)
  contents.once('destroyed', () => {
    tabs.delete(id)
    handedOver.delete(id)
  })
}

export const autofillTab = (contentsId: number): AutofillTab | undefined => tabs.get(contentsId)

/** 自动填充按哪种标签对待：交给人登录的代理标签算 user；没登记过是 null */
export function autofillKind(contentsId: number): TabKind | null {
  const tab = tabs.get(contentsId)
  if (!tab) return null
  return handedOver.has(contentsId) ? 'user' : tab.kind
}

/** 代理的标签交给人登录（on）或交还（off） */
export function setHandedOver(contentsId: number, on: boolean): void {
  if (on && tabs.has(contentsId)) handedOver.add(contentsId)
  else handedOver.delete(contentsId)
}

export const isHandedOver = (contentsId: number): boolean => handedOver.has(contentsId)

/** 交给人登录的标签开了一个弹窗（electron-host.mts 开成了用户的标签）：记下，交接结束时一并处理 */
export function notePopup(openerContentsId: number, tabId: string): void {
  let set = popups.get(openerContentsId)
  if (!set) popups.set(openerContentsId, (set = new Set()))
  set.add(tabId)
}

/** 交接结束：取走这个标签交出去期间开的弹窗 */
export function takePopups(openerContentsId: number): string[] {
  const set = popups.get(openerContentsId)
  popups.delete(openerContentsId)
  return set ? [...set] : []
}

/** 这个标签是不是某次交接里开出来的弹窗 */
export const isHandoverPopup = (tabId: string): boolean => popupRoot(tabId) !== null

/** 交接里开出来的弹窗属于哪一次交接（交出去的那个标签的 webContents 编号）；不是这样的弹窗是 null */
export function popupRoot(tabId: string): number | null {
  for (const [opener, set] of popups) if (set.has(tabId)) return opener
  return null
}

/**
 * 网页开弹窗时，新标签要不要算进某次交接：开它的是交出去的标签，或者是交接里开出来的弹窗（弹窗里再开弹窗），
 * 都记在同一次交接下，回那个交出去的标签的 webContents 编号；都不是回 null
 */
export function handoverOf(openerContentsId: number, openerTabId: string): number | null {
  return handedOver.has(openerContentsId) ? openerContentsId : popupRoot(openerTabId)
}
