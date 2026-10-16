// 把内置浏览器装进主进程：建宿主和执行器，接上界面的消息，交出设置页要的几个函数。
// main.mts 在应用就绪之后调一次 installBrowser，拿回来的 executor 登记到客户端工具的执行器表里。
import { BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, ipcMain, shell } from 'electron'
import type { ClientToolDevice } from '../client-tools/types.mjs'
import { createElectronHost, type ElectronBrowserHost, type Rect } from './electron-host.mjs'
import { type BrowserExecutor, createBrowserExecutor } from './executor.mjs'
import {
  BROWSER_CLEAR_DATA,
  BROWSER_CLOSE,
  BROWSER_EXTERNAL,
  BROWSER_FORGET_SITE,
  BROWSER_NAVIGATE,
  BROWSER_OPEN,
  BROWSER_PLACE,
  BROWSER_SHOW,
  BROWSER_SITES,
  BROWSER_STATE,
  BROWSER_TABS,
} from './ipc.mjs'
import type { TabOwner } from './model.mjs'
import { createSiteBook, type SavedSite, type SiteBook, sitesFile } from './sites.mjs'
import { BLANK, isOpenable, parseUrl, toAddress } from './url.mjs'

export interface BrowserSettings {
  /** “一直允许”的网站 */
  listSites(): SavedSite[]
  /** 删掉一条；不给 origin 全删。回删了几条 */
  forgetSite(origin?: string): number
  /** 清除浏览数据 */
  clearData(): Promise<void>
}

export interface InstalledBrowser {
  executor: BrowserExecutor
  host: ElectronBrowserHost
  sites: SiteBook
  settings: BrowserSettings
}

/**
 * 导航之前改写网址的钩子（远端 localhost 要经 ssh 转发，决 191）。这一波原样返回，第二波在这里接上
 */
export function resolveUrl(url: string, _device: ClientToolDevice): string {
  return url
}

const isRect = (value: unknown): value is Rect => {
  if (!value || typeof value !== 'object') return false
  const rect = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every(
    (key) => typeof rect[key] === 'number' && Number.isFinite(rect[key] as number),
  )
}

const isOwner = (value: unknown): value is TabOwner => {
  if (!value || typeof value !== 'object') return false
  const owner = value as Record<string, unknown>
  return (
    typeof owner.deviceId === 'string' &&
    owner.deviceId !== '' &&
    typeof owner.threadId === 'string'
  )
}

export function installBrowser(options: {
  /** 是不是界面自己的地址：只认界面主框架发来的消息 */
  isUiUrl(url: string): boolean
  /** 用户数据目录：“一直允许”存在这下面 */
  userData: string
}): InstalledBrowser {
  const host = createElectronHost()
  const sites = createSiteBook(sitesFile(options.userData))
  const executor = createBrowserExecutor({ host, sites, resolveUrl })

  const fromUi = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const frame = event.senderFrame
    return !!frame && frame === event.sender.mainFrame && options.isUiUrl(frame.url)
  }
  const broadcast = (channel: string, payload: unknown) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
    }
  }
  host.onChange((tabs) => broadcast(BROWSER_STATE, tabs))
  host.onShow((tab) => broadcast(BROWSER_SHOW, tab))

  ipcMain.on(BROWSER_PLACE, (event, payload: unknown) => {
    if (!fromUi(event)) return
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    const { tabId, rect } = (payload ?? {}) as { tabId?: unknown; rect?: unknown }
    host.place(window, typeof tabId === 'string' ? tabId : null, isRect(rect) ? rect : null)
  })
  ipcMain.handle(BROWSER_OPEN, (event, payload: unknown) => {
    if (!fromUi(event)) return null
    const { owner, url } = (payload ?? {}) as { owner?: unknown; url?: unknown }
    if (!isOwner(owner)) return null
    const address = typeof url === 'string' && url.trim() !== '' ? toAddress(url, true) : BLANK
    return host.openForUser(
      { deviceId: owner.deviceId, threadId: owner.threadId },
      address && isOpenable(address) ? address : BLANK,
    )
  })
  ipcMain.on(BROWSER_NAVIGATE, (event, payload: unknown) => {
    if (!fromUi(event)) return
    const { tabId, to } = (payload ?? {}) as { tabId?: unknown; to?: unknown }
    if (typeof tabId !== 'string' || typeof to !== 'string') return
    if (['back', 'forward', 'reload', 'stop'].includes(to)) return host.userNavigate(tabId, to)
    // 用户自己在地址栏里打的不审批；打的不是网址就拿去搜索
    const address = toAddress(to, true)
    if (address && isOpenable(address)) host.userNavigate(tabId, address)
  })
  ipcMain.on(BROWSER_CLOSE, (event, tabId: unknown) => {
    if (fromUi(event) && typeof tabId === 'string') host.close(tabId)
  })
  ipcMain.on(BROWSER_EXTERNAL, (event, tabId: unknown) => {
    if (!fromUi(event) || typeof tabId !== 'string') return
    const url = host.page(tabId)?.info().url ?? ''
    const parsed = parseUrl(url)
    if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      void shell.openExternal(parsed.toString())
    }
  })
  ipcMain.handle(BROWSER_TABS, (event) => (fromUi(event) ? host.list() : []))

  const settings: BrowserSettings = {
    listSites: () => sites.saved(),
    forgetSite: (origin) => sites.forget(origin),
    clearData: () => host.clearData(),
  }
  ipcMain.handle(BROWSER_SITES, (event) => (fromUi(event) ? settings.listSites() : []))
  ipcMain.handle(BROWSER_FORGET_SITE, (event, origin: unknown) => {
    if (!fromUi(event)) return 0
    return settings.forgetSite(typeof origin === 'string' ? origin : undefined)
  })
  ipcMain.handle(BROWSER_CLEAR_DATA, async (event) => {
    if (!fromUi(event)) return false
    await settings.clearData()
    return true
  })

  return { executor, host, sites, settings }
}
