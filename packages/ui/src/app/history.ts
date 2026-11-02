export interface History<T> {
  entries: readonly T[]
  index: number
}

export const historyOf = <T>(initial: T): History<T> => ({ entries: [initial], index: 0 })

/** 相邻位置去重；后退后的新访问清掉前进分支。 */
export function visit<T>(history: History<T>, next: T, same: (a: T, b: T) => boolean): History<T> {
  const current = history.entries[history.index]
  if (current !== undefined && same(current, next)) return history
  const entries = [...history.entries.slice(0, history.index + 1), next].slice(-100)
  return { entries, index: entries.length - 1 }
}

/** 导航时丢弃已经归档、删除的会话，离线设备的已缓存会话仍保留。 */
export function travel<T>(
  history: History<T>,
  direction: -1 | 1,
  valid: (value: T) => boolean,
): History<T> {
  for (
    let index = history.index + direction;
    index >= 0 && index < history.entries.length;
    index += direction
  ) {
    const value = history.entries[index]
    if (value !== undefined && valid(value)) return { ...history, index }
  }
  return history
}

export function without<T>(history: History<T>, keep: (value: T) => boolean): History<T> {
  const current = history.entries[history.index]
  const entries = history.entries.filter((value) => value === current || keep(value))
  return { entries, index: entries.indexOf(current as T) }
}
