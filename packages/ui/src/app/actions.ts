// 离得远的组件请应用外框办的事：开一个新对话（输入框里的 `/new`，和 Cmd/Ctrl+N 是同一个动作）、
// 打开设置页的某一组（设备详情里“去设置里看看”）、打开某个会话（提示上的“去看”）。
// 外框（App.tsx）听着，别处只管提出来。
const listeners = new Set<() => void>()

/** 到新建对话页去，建在眼前这个会话所在的工作区里 */
export function requestNewSession(): void {
  for (const listener of listeners) listener()
}

/** 外框登记自己。返回取消登记的函数 */
export function onNewSessionRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const settingsListeners = new Set<(section: string) => void>()

/** 打开设置页，到这一组（SettingsPage.tsx 的 SETTINGS_SECTIONS 里的一个） */
export function requestSettings(section: string): void {
  for (const listener of settingsListeners) listener(section)
}

export function onSettingsRequest(listener: (section: string) => void): () => void {
  settingsListeners.add(listener)
  return () => {
    settingsListeners.delete(listener)
  }
}

export interface SessionRef {
  deviceId: string
  sessionId: string
}

const openListeners = new Set<(session: SessionRef) => void>()

/** 打开这个会话（和在侧栏里点它一样） */
export function requestOpenSession(session: SessionRef): void {
  for (const listener of openListeners) listener(session)
}

export function onOpenSessionRequest(listener: (session: SessionRef) => void): () => void {
  openListeners.add(listener)
  return () => {
    openListeners.delete(listener)
  }
}
