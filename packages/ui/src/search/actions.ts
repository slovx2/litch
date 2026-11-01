import { flushSync } from 'react-dom'

const listeners = new Set<() => void>()
export function requestSearch() {
  for (const listener of listeners) listener()
}
export function onSearch(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

type FindListener = (deviceId: string, sessionId: string, origin: Element | null) => void
const preparing = new Set<FindListener>()
/** 先关闭其他查找栏、显示目标对话，再挂载新查找栏；清理全局高亮不能落在新绘制之后。 */
export function onFindPreparing(listener: FindListener) {
  preparing.add(listener)
  return () => {
    preparing.delete(listener)
  }
}
const findListeners = new Set<FindListener>()
export function requestFind(
  deviceId: string,
  sessionId: string,
  origin: Element | null = document.activeElement,
) {
  flushSync(() => {
    for (const listener of preparing) listener(deviceId, sessionId, origin)
  })
  flushSync(() => {
    for (const listener of findListeners) listener(deviceId, sessionId, origin)
  })
}
export function onFind(listener: FindListener) {
  findListeners.add(listener)
  return () => {
    findListeners.delete(listener)
  }
}
