// 对话里的链接（回答里的 Markdown 链接和网址、请求卡片上的网页、终端里的网址）点了以后：
// 默认在内置浏览器里作为眼前这个会话的用户标签打开，打开侧面板、换到浏览器标签；同一个网址已经开着就切过去。
// 远程设备的会话里的远端 localhost 由外壳照地址栏那样经 ssh 转发（apps/desktop/src/browser/install.mts 的 BROWSER_OPEN）。
// 中键、Cmd/Ctrl 点，设置里关掉了，或者没有内置浏览器（普通浏览器里的预览）：交给系统的浏览器。规矩在 link-logic.ts。
//
// 设置“对话里的链接用内置浏览器打开”记在这台电脑的界面里（litch.browser），和外观、侧面板一样不经核心。
import { useSyncExternalStore } from 'react'
import { currentPlatform } from '../../app/platform.ts'
import { showSideTab } from '../side.ts'
import { browserBridge } from './bridge.ts'
import { type LinkClick, readLinksPref, routeLink, sameUserTab } from './link-logic.ts'
import { BROWSER_TAB, chooseBrowserTab, viewingNow } from './store.ts'

const STORAGE_KEY = 'litch.browser'

function readSaved(): boolean {
  try {
    return readLinksPref(localStorage.getItem(STORAGE_KEY))
  } catch {
    return true
  }
}

let linksInBrowser = readSaved()
const listeners = new Set<() => void>()
const publish = (next: boolean) => {
  linksInBrowser = next
  for (const listener of listeners) listener()
}

// 别的窗口改了这一项：跟着变
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) publish(readSaved())
  })
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 设置页用：对话里的链接是不是用内置浏览器打开 */
export const useLinksInBrowser = (): boolean =>
  useSyncExternalStore(subscribe, () => linksInBrowser)

export function setLinksInBrowser(on: boolean): void {
  if (on === linksInBrowser) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ links: on }))
  } catch {
    // 记不下来不影响这一次
  }
  publish(on)
}

/** 在内置浏览器里开：先打开面板，标签开好了再选中它 */
function openInBrowser(url: string): boolean {
  const bridge = browserBridge()
  const owner = viewingNow()
  if (!bridge || !owner) return false
  showSideTab(BROWSER_TAB)
  void bridge
    .tabs()
    .then((tabs) => {
      const same = sameUserTab(tabs, owner, url)
      if (same) return { id: same }
      return bridge.open(owner, url)
    })
    .then(
      (tab) => {
        if (tab) chooseBrowserTab(owner, tab.id)
        else openOutside(url)
      },
      () => openOutside(url),
    )
  return true
}

/** 交给系统的浏览器。没有桌面外壳时回 false：调用方让浏览器自己处理（链接照常在新标签页里开） */
function openOutside(url: string): boolean {
  const shell = window.litchShell
  if (!shell) return false
  shell.openExternal(url)
  return true
}

/**
 * 点了一个 http/https 链接。回 true 是这里办了，调用方要拦下默认行为；回 false 是让浏览器照常处理
 * （普通浏览器里的预览）。device：链接出在哪台设备的终端里，对话里的不给
 */
export function clickLink(url: string, click: LinkClick, device?: string): boolean {
  const route = routeLink({
    click,
    mac: currentPlatform() === 'mac',
    hasBrowser: browserBridge() !== undefined,
    enabled: linksInBrowser,
    owner: viewingNow(),
    device,
  })
  if (route === 'browser' && openInBrowser(url)) return true
  return openOutside(url)
}
