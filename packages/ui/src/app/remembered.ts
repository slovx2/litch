// 新建表单的本机偏好：读写失败按没有记忆处理，不影响设备上已完成的创建。
export function readRemembered<T>(storeKey: string): Record<string, T> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storeKey) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, T>)
      : {}
  } catch {
    return {}
  }
}

export function saveRemembered(storeKey: string, value: object): void {
  try {
    localStorage.setItem(storeKey, JSON.stringify(value))
  } catch {
    // 存不进去不影响这次使用。
  }
}

export function writeRemembered<T>(storeKey: string, key: string, value: T): void {
  saveRemembered(storeKey, { ...readRemembered<T>(storeKey), [key]: value })
}
