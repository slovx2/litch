// 预加载脚本。它是界面和外壳之间唯一的接触面：帮界面拿到通往核心的消息端口、请系统的浏览器打开网址、
// 告诉外壳界面用的是哪种语言和外观、取“关于”里要的版本和许可文本、告诉界面用户选的文件在磁盘上的位置。
// 拿到端口之后界面和核心直接对话，主进程和这个脚本都不在数据路径上。
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { browserBridge } from './browser/bridge.mjs'
import {
  ABOUT,
  CORE_PORT,
  LICENSE_TEXT,
  MENU,
  OPEN_EXTERNAL,
  PICK_FOLDER,
  REQUEST_CORE_PORT,
  SET_LANGUAGE,
  SET_LOOK,
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
})

// 内置浏览器：界面报矩形、开关标签、导航，设置页取“一直允许”的网站、清除浏览数据（browser/bridge.mts）
contextBridge.exposeInMainWorld('litchBrowser', browserBridge())
