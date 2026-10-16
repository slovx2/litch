// 浏览器面板自检（probe-browser-ui.mts）用的预加载脚本：只给页面内置浏览器的接口，不给 litchShell。
// 页面没有 litchShell 就自己在页面里起模拟核心，所以这一项自检不用起核心进程。
import { contextBridge } from 'electron'
import { browserBridge } from './browser/bridge.mjs'

contextBridge.exposeInMainWorld('litchBrowser', browserBridge())
