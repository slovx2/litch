// 预加载脚本里的 window.litchApprovals：设置页“手机”一节列出、删掉记下的批准钥匙，开关手机远程批准，收“第一次记下”“对不上”的提示。
// 界面那边的类型在 packages/ui/src/devices/approvals-bridge.ts，改一边要改另一边。
import { ipcRenderer } from 'electron'
import {
  APPROVALS_CHANGED,
  APPROVALS_ENABLED,
  APPROVALS_FORGET,
  APPROVALS_LIST,
  APPROVALS_NOTICE,
  APPROVALS_SET_ENABLED,
} from './ipc.mjs'

/** 订阅主进程发来的一种消息，只把内容交给页面；回退订 */
function listen(channel: string, handler: (payload: unknown) => void): () => void {
  const listener = (_event: unknown, payload: unknown) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

export const approvalsBridge = {
  list: () => ipcRenderer.invoke(APPROVALS_LIST),
  forget: (phoneId: string) => ipcRenderer.invoke(APPROVALS_FORGET, String(phoneId)),
  enabled: () => ipcRenderer.invoke(APPROVALS_ENABLED),
  setEnabled: (on: boolean) => ipcRenderer.invoke(APPROVALS_SET_ENABLED, on === true),
  onChanged: (handler: () => void) => listen(APPROVALS_CHANGED, () => handler()),
  onNotice: (handler: (notice: unknown) => void) => listen(APPROVALS_NOTICE, handler),
}
