// Electron 替身：测试绝不启动窗口或系统对话框。
export const handlers = new Map<string, (...args: unknown[]) => unknown>()
export const events = new Map<string, (...args: unknown[]) => unknown>()
export const shown: unknown[] = []
export const opened: string[] = []
export const shellCalls: { method: string; path: string }[] = []
let selection = '/local/output.txt'
export const choose = (path: string) => {
  selection = path
}
export const ipcMain = {
  handle(name: string, fn: (...args: unknown[]) => unknown) {
    handlers.set(name, fn)
  },
}
export const app = {
  on(name: string, fn: (...args: unknown[]) => unknown) {
    events.set(name, fn)
  },
}
export const BrowserWindow = {
  fromWebContents() {
    return null
  },
}
export const dialog = {
  async showSaveDialog(options: unknown) {
    shown.push(options)
    return { canceled: !selection, filePath: selection }
  },
}
export const shell = {
  async openPath(path: string) {
    shellCalls.push({ method: 'openPath', path })
    opened.push(path)
    return ''
  },
  showItemInFolder(path: string) {
    shellCalls.push({ method: 'showItemInFolder', path })
    opened.push(path)
  },
}
