// 预加载脚本里给界面的导入接口，挂在 window.litchBrowser.import 上（../browser/bridge.mts 把它并进去）。
// 形状见 types.mts 的 BrowserImportBridge；界面那边的类型在 packages/ui/src/side/browser/bridge.ts，改一边要改另一边。
import { ipcRenderer } from 'electron'
import {
  IMPORT_CANCEL,
  IMPORT_DISMISS_BANNER,
  IMPORT_PROGRESS,
  IMPORT_SOURCES,
  IMPORT_START,
  IMPORT_STATE,
} from './ipc.mjs'

export function importBridge() {
  return {
    sources: () => ipcRenderer.invoke(IMPORT_SOURCES),
    start: (request: unknown) => ipcRenderer.invoke(IMPORT_START, request),
    cancel: () => ipcRenderer.invoke(IMPORT_CANCEL),
    onProgress(listener: (progress: unknown) => void) {
      const handler = (_event: unknown, progress: unknown) => listener(progress)
      ipcRenderer.on(IMPORT_PROGRESS, handler)
      return () => {
        ipcRenderer.removeListener(IMPORT_PROGRESS, handler)
      }
    },
    state: () => ipcRenderer.invoke(IMPORT_STATE),
    dismissBanner: () => ipcRenderer.invoke(IMPORT_DISMISS_BANNER),
  }
}
