// 预加载脚本。它是界面和外壳之间唯一的接触面：帮界面拿到通往核心的消息端口、请系统的浏览器打开网址、
// 告诉外壳界面用的是哪种语言和外观、取“关于”里要的版本和许可文本、告诉界面用户选的文件在磁盘上的位置，
// 以及设置页里内置浏览器、Computer Use 那两节要的几件事（各自一个全局对象，和 litchShell 分开）。
// 拿到端口之后界面和核心直接对话，主进程和这个脚本都不在数据路径上。
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { browserBridge } from './browser/bridge.mjs'
import {
  ABOUT,
  COMPUTER_USE_APPS,
  COMPUTER_USE_FORGET_APP,
  COMPUTER_USE_OPEN_SETTINGS,
  COMPUTER_USE_RESTART,
  COMPUTER_USE_STATUS,
  CORE_PORT,
  LICENSE_TEXT,
  MENU,
  NOTIFY,
  NOTIFY_CLICK,
  OPEN_EXTERNAL,
  PICK_FOLDER,
  REQUEST_CORE_PORT,
  SET_LANGUAGE,
  SET_LOOK,
  UPDATE_CHECK,
  UPDATE_GET,
  UPDATE_INSTALL,
  UPDATE_SET_AUTO,
  UPDATE_STATE,
} from './ipc.mjs'

// 端口到了隔离环境里，要再转一手才能进到页面自己的环境
ipcRenderer.on(CORE_PORT, (event) => {
  window.postMessage({ type: CORE_PORT }, '*', event.ports)
})

contextBridge.exposeInMainWorld('litchShell', {
  kind: 'electron',
  platform: process.platform,
  requestCorePort: () => ipcRenderer.send(REQUEST_CORE_PORT),
  openExternal: (url: string) => ipcRenderer.send(OPEN_EXTERNAL, url),
  setLanguage: (lang: string) => ipcRenderer.send(SET_LANGUAGE, lang),
  // 用户自己选中、拖进来、贴进来的文件在磁盘上的位置：往消息里提到一个本机文件时要它。
  // 只认页面手里已经有的文件对象，给不出别的路径；不是从磁盘来的（剪贴板里的截图）是空的
  pathOf(file: File): string {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  // 皮肤、明暗、缩放：缩放是主进程做的，窗口的底色它下次冷启动要用
  setLook: (look: unknown) => ipcRenderer.send(SET_LOOK, look),
  // “关于”里的版本和许可文本
  about: () => ipcRenderer.invoke(ABOUT),
  licenseText: (id: string) => ipcRenderer.invoke(LICENSE_TEXT, id),
  // 添加项目时用系统的对话框选一个本机目录
  pickFolder: (options: { defaultPath?: string; title?: string }) =>
    ipcRenderer.invoke(PICK_FOLDER, options),
  // 应用菜单里要界面来办的那几项。只把是哪一项交给页面，事件对象不给
  onMenu(handler: (action: string) => void) {
    const listener = (_event: unknown, action: unknown) => {
      if (typeof action === 'string') handler(action)
    }
    ipcRenderer.on(MENU, listener)
    return () => {
      ipcRenderer.removeListener(MENU, listener)
    }
  },
  // 定时任务跑完了的系统通知：界面拼好文字交过来；点了哪一条再告诉界面
  notify: (notice: { id: string; title: string; body: string }) => ipcRenderer.send(NOTIFY, notice),
  onNotifyClick(handler: (id: string) => void) {
    const listener = (_event: unknown, id: unknown) => {
      if (typeof id === 'string') handler(id)
    }
    ipcRenderer.on(NOTIFY_CLICK, listener)
    return () => {
      ipcRenderer.removeListener(NOTIFY_CLICK, listener)
    }
  },
})

// 内置浏览器：界面报矩形、开关标签、导航，设置页取“一直允许”的网站、清除浏览数据（browser/bridge.mts）
contextBridge.exposeInMainWorld('litchBrowser', browserBridge())

// 应用自己的更新（updater.mts）：设置的“关于”里的状态和按钮、下好之后的提示。
// 界面那边的类型在 packages/ui/src/settings/update-bridge.ts，改一边要改另一边
contextBridge.exposeInMainWorld('litchUpdate', {
  get: () => ipcRenderer.invoke(UPDATE_GET),
  check: () => ipcRenderer.invoke(UPDATE_CHECK),
  install: () => ipcRenderer.invoke(UPDATE_INSTALL),
  setAuto: (on: boolean) => ipcRenderer.invoke(UPDATE_SET_AUTO, on === true),
  onState(handler: (state: unknown) => void) {
    const listener = (_event: unknown, state: unknown) => handler(state)
    ipcRenderer.on(UPDATE_STATE, listener)
    return () => {
      ipcRenderer.removeListener(UPDATE_STATE, listener)
    }
  },
})

// Computer Use（macOS 和 Windows 上有）：设置页里那一节要的状态（macOS 是两项权限，Windows 是助手的状态）、
// 打开系统设置对应的那一页（只有 macOS）、重启助手、“始终允许”的清单。
// 界面那边的类型在 packages/ui/src/settings/computer-bridge.ts，改一边要改另一边。别的系统上没有这个对象，界面就不显示那一节
if (process.platform === 'darwin' || process.platform === 'win32') {
  contextBridge.exposeInMainWorld('litchComputerUse', {
    platform: process.platform,
    // launch：助手没在跑时要不要拉起它（设置页那一节要，设备详情里顺带看一眼不要）
    status: (launch: boolean) => ipcRenderer.invoke(COMPUTER_USE_STATUS, launch === true),
    openSettings: (pane: string) => ipcRenderer.invoke(COMPUTER_USE_OPEN_SETTINGS, pane),
    restart: () => ipcRenderer.invoke(COMPUTER_USE_RESTART),
    apps: () => ipcRenderer.invoke(COMPUTER_USE_APPS),
    forgetApp: (bundleId: string) => ipcRenderer.invoke(COMPUTER_USE_FORGET_APP, bundleId),
  })
}
