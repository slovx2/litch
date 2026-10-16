// 离得远的组件请应用外框办的事。现在只有一件：开一个新对话
// （输入框里的 `/new`，和 Cmd/Ctrl+N 是同一个动作）。外框（App.tsx）听着，别处只管提出来。
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
