// 把内置浏览器装进主进程：建宿主和执行器，接上界面的消息，交出设置页要的几个函数。
// main.mts 在应用就绪之后调一次 installBrowser，拿回来的 executor 登记到客户端工具的执行器表里。
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { RemoteTarget } from '@litch/core'
import {
  app,
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  shell,
} from 'electron'
import { installBrowserImport } from '../browser-import/install.mjs'
import { fileDeviceStore } from '../device-store.mjs'
import { createElectronHost, type ElectronBrowserHost, type Rect } from './electron-host.mjs'
import { type BrowserExecutor, createBrowserExecutor } from './executor.mjs'
import { type BrowserForwarding, createBrowserForwarding } from './forwarding.mjs'
import {
  BROWSER_BLOCK,
  BROWSER_CLEAR_DATA,
  BROWSER_CLOSE,
  BROWSER_EXTERNAL,
  BROWSER_FORGET_SITE,
  BROWSER_NAVIGATE,
  BROWSER_OPEN,
  BROWSER_PLACE,
  BROWSER_POLICY,
  BROWSER_POLICY_CHANGED,
  BROWSER_SHOW,
  BROWSER_SITES,
  BROWSER_STATE,
  BROWSER_TABS,
  BROWSER_TRUST_ALL,
  BROWSER_UNBLOCK,
} from './ipc.mjs'
import type { TabOwner } from './model.mjs'
import { createHandover } from './passwords/handover.mjs'
import { installPasswords } from './passwords/install.mjs'
import { createSignIns } from './passwords/signin.mjs'
import type { PasswordStore } from './passwords/store.mjs'
import {
  createSiteBook,
  type SavedSite,
  type SiteBook,
  type SitePolicy,
  sitesFile,
} from './sites.mjs'
import { BLANK, blockedHostOf, isOpenable, parseUrl, toAddress } from './url.mjs'

export interface BrowserSettings {
  /** “一直允许”的网站 */
  listSites(): SavedSite[]
  /** 删掉一条；不给 origin 全删。回删了几条 */
  forgetSite(origin?: string): number
  /** 清除浏览数据 */
  clearData(): Promise<void>
  /** 信任所有网站的开关和黑名单 */
  policy(): SitePolicy
  setTrustAll(on: boolean): SitePolicy
  /** 加一项黑名单（人写的网站）；认不出是 null */
  block(site: string): SitePolicy | null
  /** 去掉一项黑名单（人写的网站，认不出就当没有）；不给全去掉。回去掉了几项 */
  unblock(site?: string): number
}

export interface InstalledBrowser {
  executor: BrowserExecutor
  host: ElectronBrowserHost
  sites: SiteBook
  settings: BrowserSettings
  /** 远端 localhost 的端口转发 */
  forwarding: BrowserForwarding
  /** 已保存的密码（导入管线写进来，用户标签自动填充） */
  passwords: PasswordStore
}

/**
 * 设备配置（用户数据目录的 devices.json）里各台远程设备的 ssh 目标。核心改了配置就会重写这个文件，
 * 这里按修改时间缓存，变了再读
 */
function deviceTargets(userData: string): (deviceId: string) => RemoteTarget | null {
  const file = join(userData, 'devices.json')
  let stamp = -1
  let targets = new Map<string, RemoteTarget>()
  return (deviceId) => {
    let now = 0
    try {
      now = statSync(file).mtimeMs
    } catch {
      now = 0
    }
    if (now !== stamp) {
      stamp = now
      targets = new Map(
        fileDeviceStore(userData)
          .load()
          .remotes.map((remote) => [remote.id, remote.target]),
      )
    }
    return targets.get(deviceId) ?? null
  }
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
  // 远端 localhost：会话在 ssh 设备上时经 ssh 转发到这台电脑的回环上再打开
  const forwarding = createBrowserForwarding({
    targetOf: deviceTargets(options.userData),
    tabs: () => host.list(),
    portsFile: join(options.userData, 'browser', 'forwards.json'),
    log: (line) => console.error(`[browser] ${line}`),
  })
  host.setNavigationRewrite((page, url) => forwarding.rewrite(page, url))
  app.on('will-quit', () => forwarding.close())
  // 代理把标签交给人登录（request_sign_in）：卡片推给界面在 installPasswords 里接
  const signIns = createSignIns()
  /** 密码库建得比交接晚（下面的 installPasswords），交接用的时候再取 */
  let passwordStore: PasswordStore | null = null
  const executor = createBrowserExecutor({
    host,
    sites,
    resolveUrl: forwarding.resolveUrl,
    describeUrl: forwarding.describeUrl,
    // 手机答复的验签还没接上（approvals/verify.mts）：先一律不认
    handover: createHandover({ host, signIns, store: () => passwordStore }),
  })

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
    const target = address && isOpenable(address) ? address : BLANK
    const tabOwner = { deviceId: owner.deviceId, threadId: owner.threadId }
    // 远程会话里打的远端 localhost：先开空白标签，转发就绪了再去改写后的地址
    if (!forwarding.needs(owner.deviceId, target)) return host.openForUser(tabOwner, target)
    const tab = host.openForUser(tabOwner, BLANK)
    void forwarding.forUser(owner.deviceId, target).then((next) => host.userNavigate(tab.id, next))
    return tab
  })
  ipcMain.on(BROWSER_NAVIGATE, (event, payload: unknown) => {
    if (!fromUi(event)) return
    const { tabId, to } = (payload ?? {}) as { tabId?: unknown; to?: unknown }
    if (typeof tabId !== 'string' || typeof to !== 'string') return
    if (to === 'reload') {
      // 转发出来的地址、转发这会儿没在跑（ssh 退了还没重起）：先把它重起再刷新
      const info = host.page(tabId)?.info()
      if (info && forwarding.needs(info.owner.deviceId, info.url)) {
        void forwarding
          .forUser(info.owner.deviceId, info.url)
          .then((next) => host.userNavigate(tabId, next === info.url ? 'reload' : next))
        return
      }
    }
    if (['back', 'forward', 'reload', 'stop'].includes(to)) return host.userNavigate(tabId, to)
    // 用户自己在地址栏里打的不审批；打的不是网址就拿去搜索
    const address = toAddress(to, true)
    if (!address || !isOpenable(address)) return
    // 远程会话的标签里打的远端 localhost：经 ssh 转发，改写之后再去
    const deviceId = host.page(tabId)?.info().owner.deviceId
    if (!deviceId || !forwarding.needs(deviceId, address)) return host.userNavigate(tabId, address)
    void forwarding.forUser(deviceId, address).then((next) => host.userNavigate(tabId, next))
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

  // 开关和黑名单在设置页、审批卡片、litch config 三处都能改：改了告诉所有窗口
  const changed = () => {
    const policy = sites.policy()
    broadcast(BROWSER_POLICY_CHANGED, policy)
    return policy
  }
  const settings: BrowserSettings = {
    listSites: () => sites.saved(),
    forgetSite: (origin) => sites.forget(origin),
    clearData: () => host.clearData(),
    policy: () => sites.policy(),
    setTrustAll(on) {
      sites.setTrustAll(on)
      return changed()
    },
    block(site) {
      const blocked = blockedHostOf(site)
      if (!blocked) return null
      sites.block(blocked)
      return changed()
    },
    unblock(site) {
      if (site === undefined) {
        const removed = sites.unblock()
        changed()
        return removed
      }
      const blocked = blockedHostOf(site)
      const removed = blocked ? sites.unblock(blocked) : 0
      changed()
      return removed
    },
  }
  ipcMain.handle(BROWSER_SITES, (event) => (fromUi(event) ? settings.listSites() : []))
  ipcMain.handle(BROWSER_FORGET_SITE, (event, origin: unknown) => {
    if (!fromUi(event)) return 0
    return settings.forgetSite(typeof origin === 'string' ? origin : undefined)
  })
  ipcMain.handle(BROWSER_POLICY, (event) => (fromUi(event) ? settings.policy() : null))
  ipcMain.handle(BROWSER_TRUST_ALL, (event, on: unknown) => {
    if (!fromUi(event) || typeof on !== 'boolean') return null
    return settings.setTrustAll(on)
  })
  ipcMain.handle(BROWSER_BLOCK, (event, site: unknown) => {
    if (!fromUi(event) || typeof site !== 'string') return null
    return settings.block(site)
  })
  ipcMain.handle(BROWSER_UNBLOCK, (event, site: unknown) => {
    if (!fromUi(event)) return null
    settings.unblock(typeof site === 'string' ? site : undefined)
    return settings.policy()
  })
  // 已保存的密码：设置页的列、删，用户标签的自动填充（passwords/install.mts）。清除浏览数据不碰它
  const passwords = installPasswords({ userData: options.userData, fromUi, broadcast, signIns })
  passwordStore = passwords
  ipcMain.handle(BROWSER_CLEAR_DATA, async (event) => {
    if (!fromUi(event)) return false
    await settings.clearData()
    return true
  })

  // 从别的浏览器导入：window.litchBrowser.import 的几条消息（browser-import/install.mts）
  installBrowserImport({ fromUi, userData: options.userData, passwords })

  return { executor, host, sites, settings, forwarding, passwords }
}
