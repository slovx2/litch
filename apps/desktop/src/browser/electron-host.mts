// 内置浏览器在主进程里的宿主：所有标签（WebContentsView）、共用分区的安全设置、把标签叠到界面报来的那块矩形上。
//
// 面板关着、或者标签不是眼前显示的那个时，视图从窗口上摘下来，不挂在任何窗口里。实测（Electron 44，
// probe-browser-v0.mts）：摘下来的视图 CDP 截图、鼠标、键盘、插入文字都照常；移出可视区（坐标放到窗口外）
// 和 setVisible(false) 反而不行（截图超时、点击丢失）。摘下来的页面算“看不见”，rAF 停着，所以代理在用时关掉
// 后台节流（electron-tab.mts 的 setAgentActive），这时页面算看得见、rAF 照跑。截图一律用 CDP，
// 不用 capturePage（关了节流的摘下视图上它会超时）。

import { type BrowserWindow, session } from 'electron'
import { createTab, HIDDEN_BOUNDS, type HostTab, PARTITION } from './electron-tab.mjs'
import type { BrowserHost, BrowserPage, OpenOptions, TabInfo, TabKind, TabOwner } from './model.mjs'
import { isHandedOver, notePopup } from './passwords/tabs.mjs'

/** 界面报来的矩形（界面页面里的 CSS 像素） */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface ElectronBrowserHost extends BrowserHost {
  /** 界面说：这个窗口里，这块矩形上显示这个标签。tabId 或 rect 是 null 就是什么都不显示（面板收起、被浮层挡着） */
  place(window: BrowserWindow, tabId: string | null, rect: Rect | null): void
  /** 用户在面板里开的标签：不审批 */
  openForUser(owner: TabOwner, url: string): TabInfo
  /** 用户在地址栏里打的、点的前进后退刷新停止 */
  userNavigate(id: string, to: string): void
  list(): TabInfo[]
  /** 标签有变化时（合并到下一拍）通知；回一个取消的函数 */
  onChange(listener: (tabs: TabInfo[]) => void): () => void
  /** 代理要给用户看某个标签（show 工具） */
  onShow(listener: (tab: TabInfo) => void): () => void
  /** 清除浏览数据：cookie、站点存储、缓存、登录的凭据 */
  clearData(): Promise<void>
  /**
   * 网页自己要去的地址（点链接、重定向、开新窗口）先过这个改写：远程会话里的远端 localhost 要经 ssh 转发。
   * 不用改回 null
   */
  setNavigationRewrite(rewrite: (page: BrowserPage, url: string) => Promise<string> | null): void
}

let partitionReady = false

/** 共用分区的安全设置：网页的权限一律拒绝，下载不做，屏幕共享不给 */
function guardPartition(tabOf: (contentsId: number) => HostTab | undefined): void {
  if (partitionReady) return
  partitionReady = true
  const shared = session.fromPartition(PARTITION)
  shared.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  shared.setPermissionCheckHandler(() => false)
  shared.setDevicePermissionHandler(() => false)
  shared.setDisplayMediaRequestHandler((_request, callback) => callback(null))
  shared.setPreloads([])
  shared.on('will-download', (event, item, contents) => {
    event.preventDefault()
    item.cancel()
    tabOf(contents.id)?.notice(
      `A download (${item.getFilename()}) was blocked: the Litch browser does not download files.`,
    )
  })
}

export function createElectronHost(): ElectronBrowserHost {
  const tabs = new Map<string, HostTab>()
  let seq = 0
  let gate: (page: BrowserPage, url: string) => boolean = () => false
  let rewrite: (page: BrowserPage, url: string) => Promise<string> | null = () => null
  const changeListeners = new Set<(tabs: TabInfo[]) => void>()
  const showListeners = new Set<(tab: TabInfo) => void>()
  /** 每个窗口里现在显示的是哪个标签 */
  const shown = new Map<BrowserWindow, string>()
  let pending = false

  guardPartition((contentsId) =>
    [...tabs.values()].find((tab) => tab.view.webContents.id === contentsId),
  )

  const list = () => [...tabs.values()].map((tab) => tab.info())
  const changed = () => {
    if (pending) return
    pending = true
    setTimeout(() => {
      pending = false
      const snapshot = list()
      for (const listener of changeListeners) listener(snapshot)
    }, 16)
  }

  const detach = (tab: HostTab) => {
    for (const [window, id] of shown) {
      if (id !== tab.id) continue
      if (!window.isDestroyed() && window.contentView.children.includes(tab.view)) {
        window.contentView.removeChildView(tab.view)
      }
      tab.view.setBounds(HIDDEN_BOUNDS)
      shown.delete(window)
    }
  }

  const open = (owner: TabOwner, kind: TabKind, options: OpenOptions = {}): HostTab => {
    const id = `t${++seq}`
    const tab = createTab(id, { ...owner }, kind, options.keep === true, {
      changed,
      gate: (page, url) => gate(page, url),
      rewrite: (page, url) => rewrite(page, url),
      popup(from, url) {
        // 网页要开的新窗口改成同一个会话里的新标签。代理的标签开出来的还是代理的（回合结束时关）
        if (from.kind === 'agent' && from.info().agentActive && !gate(from, url)) {
          from.notice(
            `The page tried to open ${url} in a new window, which is not approved yet; it was blocked.`,
          )
          return
        }
        // 交给人登录的标签开的弹窗（单点登录常用）：开成用户的标签，代理碰不到，交接结束时一并处理
        const handed = isHandedOver(from.view.webContents.id)
        const next = open(from.owner, handed ? 'user' : from.kind)
        if (handed) notePopup(from.view.webContents.id, next.id)
        const rewritten = rewrite(from, url)
        if (rewritten) {
          rewritten.then(
            (target) => void next.load(target, 30_000),
            (reason: unknown) =>
              next.notice(
                `Could not open ${url}: ${reason instanceof Error ? reason.message : String(reason)}`,
              ),
          )
        } else void next.load(url, 30_000)
        if (!handed) from.notice(`The page opened ${url} in a new tab ${next.id}.`)
      },
    })
    tabs.set(id, tab)
    void tab.view.webContents.loadURL('about:blank').catch(() => {})
    changed()
    return tab
  }

  const close = (id: string) => {
    const tab = tabs.get(id)
    if (!tab) return
    detach(tab)
    tabs.delete(id)
    tab.destroy()
    changed()
  }

  return {
    pages: () => [...tabs.values()],
    page: (id) => tabs.get(id),
    open,
    close,
    setKeep(id, keep) {
      const tab = tabs.get(id)
      if (!tab) return
      tab.keep = keep
      changed()
    },
    release(id) {
      tabs.get(id)?.release()
    },
    show(id) {
      const tab = tabs.get(id)
      if (!tab) return
      const info = tab.info()
      for (const listener of showListeners) listener(info)
    },
    setNavigationGate(next) {
      gate = next
    },
    setNavigationRewrite(next) {
      rewrite = next
    },
    place(window, tabId, rect) {
      const before = shown.get(window)
      const next = tabId ? tabs.get(tabId) : undefined
      if (before && (before !== next?.id || !rect)) {
        const old = tabs.get(before)
        if (old && !window.isDestroyed() && window.contentView.children.includes(old.view)) {
          window.contentView.removeChildView(old.view)
        }
        old?.view.setBounds(HIDDEN_BOUNDS)
        shown.delete(window)
      }
      if (!next || !rect || window.isDestroyed()) return
      // 同一个标签只能挂在一个窗口里：别的窗口里显示着就先摘下来
      detach(next)
      const zoom = window.webContents.getZoomFactor()
      window.contentView.addChildView(next.view)
      next.view.setBounds({
        x: Math.round(rect.x * zoom),
        y: Math.round(rect.y * zoom),
        width: Math.max(0, Math.round(rect.width * zoom)),
        height: Math.max(0, Math.round(rect.height * zoom)),
      })
      shown.set(window, next.id)
      if (!windowsWatched.has(window)) {
        windowsWatched.add(window)
        window.once('closed', () => shown.delete(window))
      }
    },
    openForUser(owner, url) {
      const tab = open(owner, 'user')
      if (url !== 'about:blank') void tab.load(url, 30_000)
      return tab.info()
    },
    userNavigate(id, to) {
      const tab = tabs.get(id)
      if (!tab) return
      const contents = tab.view.webContents
      if (to === 'back') contents.navigationHistory.goBack()
      else if (to === 'forward') contents.navigationHistory.goForward()
      else if (to === 'reload') contents.reload()
      else if (to === 'stop') contents.stop()
      else void tab.load(to, 30_000)
    },
    list,
    onChange(listener) {
      changeListeners.add(listener)
      return () => changeListeners.delete(listener)
    },
    onShow(listener) {
      showListeners.add(listener)
      return () => showListeners.delete(listener)
    },
    async clearData() {
      const shared = session.fromPartition(PARTITION)
      await shared.clearStorageData()
      await shared.clearCache()
      await shared.clearAuthCache()
    },
  }
}

const windowsWatched = new WeakSet<BrowserWindow>()
