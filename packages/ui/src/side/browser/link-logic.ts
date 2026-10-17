// 对话里的链接点了去哪：内置浏览器还是系统的浏览器。只有规矩，不碰页面和外壳，好单独测
// （test/browser-links.test.mjs）。动手的一半在 links.ts。
import type { BrowserOwner, BrowserTabInfo } from './bridge.ts'

/** 点的那一下：哪个键、按着什么 */
export interface LinkClick {
  /** 0：左键（键盘回车也算），1：中键 */
  button: number
  metaKey: boolean
  ctrlKey: boolean
}

export type LinkRoute = 'browser' | 'external'

/**
 * 去哪：
 * - 中键、Cmd（macOS）或 Ctrl（别的系统）点的：系统的浏览器，这是留给人的退路；
 * - 没有内置浏览器（普通浏览器里的预览）、设置里关掉了、眼前没有会话（设置这类页面、只读的已归档对话）：系统的浏览器；
 * - 链接出在某台设备的终端里，而眼前的会话在别的设备上：系统的浏览器（远端 localhost 要按终端那台设备转发，
 *   挂到别的会话名下会转错地方）；
 * - 别的都在内置浏览器里，作为眼前这个会话的用户标签打开。
 * 只管 http 和 https，别的协议调用方照旧处理。
 */
export function routeLink(input: {
  click: LinkClick
  mac: boolean
  hasBrowser: boolean
  enabled: boolean
  owner: BrowserOwner | null
  /** 链接是哪台设备上的（终端里的）；对话里的链接不给 */
  device?: string | undefined
}): LinkRoute {
  const { click, mac, hasBrowser, enabled, owner, device } = input
  if (click.button === 1) return 'external'
  if (mac ? click.metaKey : click.ctrlKey) return 'external'
  if (!hasBrowser || !enabled || !owner) return 'external'
  if (device !== undefined && device !== owner.deviceId) return 'external'
  return 'browser'
}

/** 网址的规范写法（主机名小写、补斜杠这类）；认不出来的照原样 */
const canonical = (url: string): string => {
  try {
    return new URL(url).href
  } catch {
    return url
  }
}

/**
 * 这个会话里已经开着这个网址的用户标签：有就切过去，不再开一个。代理开的标签不算（代理可能正用着），
 * 远程会话转发过的地址和原来的写法不一样，认不出来，会另开一个
 */
export function sameUserTab(
  tabs: readonly BrowserTabInfo[],
  owner: BrowserOwner,
  url: string,
): string | null {
  const wanted = canonical(url)
  const found = tabs.find(
    (tab) =>
      tab.kind === 'user' &&
      tab.owner.deviceId === owner.deviceId &&
      tab.owner.threadId === owner.threadId &&
      canonical(tab.url) === wanted,
  )
  return found?.id ?? null
}

/** 设置“对话里的链接用内置浏览器打开”存下来的样子：认不出来的一律当默认（开） */
export function readLinksPref(raw: string | null): boolean {
  if (raw === null) return true
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && (parsed as { links?: unknown }).links === false)
      return false
  } catch {
    // 坏了就当默认
  }
  return true
}
