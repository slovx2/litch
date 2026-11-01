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

const findListeners = new Set<(deviceId: string, sessionId: string) => void>()
export function requestFind(deviceId: string, sessionId: string) {
  for (const listener of findListeners) listener(deviceId, sessionId)
}
export function onFind(listener: (deviceId: string, sessionId: string) => void) {
  findListeners.add(listener)
  return () => {
    findListeners.delete(listener)
  }
}
