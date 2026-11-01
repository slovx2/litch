// “请你做”与决策共用提交栏，草稿独立存储，避免改变既有答案结构。
import { useSyncExternalStore } from 'react'
import type { ManagerSubmittedRequest } from '../../../core/src/model-manager.mts'
export type RequestDrafts = Record<string, ManagerSubmittedRequest>
const cache = new Map<string, RequestDrafts>()
const listeners = new Set<() => void>()
function read(key: string): RequestDrafts {
  const cached = cache.get(key)
  if (cached) return cached
  const drafts: RequestDrafts = {}
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '{}')
    for (const [id, entry] of Object.entries(raw)) {
      const value = entry as Partial<ManagerSubmittedRequest> | null
      if (
        /^R-[1-9]\d*$/.test(id) &&
        value?.requestId === id &&
        Number.isSafeInteger(value.revision) &&
        typeof value.delivered === 'boolean' &&
        typeof value.text === 'string'
      )
        drafts[id] = value as ManagerSubmittedRequest
    }
  } catch {
    /* 损坏的草稿不覆盖设备记录。 */
  }
  cache.set(key, drafts)
  return drafts
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function useRequestDrafts(deviceId: string, managerId: string) {
  const key = `litch.manager.requests:${JSON.stringify([deviceId, managerId])}`
  const drafts = useSyncExternalStore(subscribe, () => read(key))
  const write = (next: RequestDrafts) => {
    localStorage.setItem(key, JSON.stringify(next))
    cache.set(key, next)
    for (const listener of listeners) listener()
  }
  return { drafts, write }
}
export const submittedRequests = (drafts: RequestDrafts) =>
  Object.values(drafts).filter((draft) => draft.delivered || draft.text.trim())
