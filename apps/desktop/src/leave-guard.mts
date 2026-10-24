// 关窗口、退出之前，界面上有没保存的改动（harness 详情设置）时先拦下来，请界面问“保存 / 放弃 / 取消”
// （界面那边是 packages/ui/src/app/leave-guard.tsx）。界面有改动、没改动时各报一次（UNSAVED）；
// 拦下来之后发 LEAVE_ASK，界面问完了可以走（保存成了或者放弃了）回 LEAVE_GO，这边接着做被拦下的那件事。
// 点了取消什么都不回，被拦下的那件事就不做了。
import { type BrowserWindow, ipcMain, type WebContents } from 'electron'
import { LEAVE_ASK, LEAVE_GO, UNSAVED } from './ipc.mjs'

/** 界面报了有没保存的改动的那些页面 */
const unsaved = new Set<number>()
/** 正在等界面问完：问完了接着做什么（按页面） */
const pending = new Map<number, () => void>()

/**
 * 装上：isUi 认发消息的是不是界面自己的主框架（别的页面报的不算）
 */
export function installLeaveGuard(isUi: (sender: WebContents, frame: unknown) => boolean): void {
  ipcMain.on(UNSAVED, (event, value: unknown) => {
    if (!isUi(event.sender, event.senderFrame)) return
    if (value === true) unsaved.add(event.sender.id)
    else unsaved.delete(event.sender.id)
  })
  ipcMain.on(LEAVE_GO, (event) => {
    if (!isUi(event.sender, event.senderFrame)) return
    const then = pending.get(event.sender.id)
    pending.delete(event.sender.id)
    unsaved.delete(event.sender.id)
    then?.()
  })
}

/**
 * 这个页面有没保存的改动的话拦下来请它问，问完了做 then；回 true 是拦下了（调用方这一次先别做）
 */
function ask(contents: WebContents, then: () => void): boolean {
  if (contents.isDestroyed() || !unsaved.has(contents.id)) return false
  pending.set(contents.id, then)
  contents.send(LEAVE_ASK)
  return true
}

/** 关窗口之前问 */
export function guardWindow(window: BrowserWindow): void {
  const { webContents } = window
  const id = webContents.id
  window.on('close', (event) => {
    if (ask(webContents, () => window.close())) event.preventDefault()
  })
  window.on('closed', () => {
    unsaved.delete(id)
    pending.delete(id)
  })
}

/**
 * 退出（含重启以更新）之前问：有一个窗口拦下了就回 true，调用方这一次先别退，问完了做 then
 */
export function guardQuit(windows: BrowserWindow[], then: () => void): boolean {
  return windows.some((window) => ask(window.webContents, then))
}
