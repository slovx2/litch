// 预加载脚本里给界面的内置浏览器接口（挂在 window.litchBrowser 上，和 litchShell 分开）。
// 界面只能经它报矩形、开关标签、导航；拿不到视图本身，也拿不到 Electron 的事件对象。
// 类型在界面那边另有一份（packages/ui/src/side/browser/bridge.ts），改一边要改另一边。
import { ipcRenderer } from 'electron'
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

const listen = (channel: string, handler: (payload: unknown) => void) => {
  const listener = (_event: unknown, payload: unknown) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

export function browserBridge() {
  return {
    place: (tabId: string | null, rect: unknown) =>
      ipcRenderer.send(BROWSER_PLACE, { tabId, rect }),
    open: (owner: { deviceId: string; threadId: string }, url: string) =>
      ipcRenderer.invoke(BROWSER_OPEN, { owner, url }),
    navigate: (tabId: string, to: string) => ipcRenderer.send(BROWSER_NAVIGATE, { tabId, to }),
    close: (tabId: string) => ipcRenderer.send(BROWSER_CLOSE, tabId),
    openExternal: (tabId: string) => ipcRenderer.send(BROWSER_EXTERNAL, tabId),
    tabs: () => ipcRenderer.invoke(BROWSER_TABS),
    onState: (handler: (tabs: unknown) => void) => listen(BROWSER_STATE, handler),
    onShow: (handler: (tab: unknown) => void) => listen(BROWSER_SHOW, handler),
    // 设置页用：一直允许的网站、删掉、清除浏览数据
    sites: () => ipcRenderer.invoke(BROWSER_SITES),
    forgetSite: (origin: string | null) => ipcRenderer.invoke(BROWSER_FORGET_SITE, origin),
    clearData: () => ipcRenderer.invoke(BROWSER_CLEAR_DATA),
  }
}
