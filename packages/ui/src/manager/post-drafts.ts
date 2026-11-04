// 通用追问草稿按经理共享，窗口存储事件也能触发更新。
import { useSyncExternalStore } from 'react'
import type { ManagerPostId } from '../../../protocol/src/manager-posts.mjs'
export interface PostDraft {
  id: ManagerPostId
  revision: number
  question: string
}
export type PostDrafts = Record<string, PostDraft>
const cache = new Map<string, PostDrafts>()
const listeners = new Set<() => void>()
const publish = () => {
  for (const listener of listeners) listener()
}
function read(key: string): PostDrafts {
  const found = cache.get(key)
  if (found) return found
  let value: PostDrafts = {}
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '{}')
    for (const [id, draft] of Object.entries(raw)) {
      const one = draft as PostDraft
      if (one?.id === id && typeof one.question === 'string' && Number.isSafeInteger(one.revision))
        value[id] = one
    }
  } catch {
    value = {}
  }
  cache.set(key, value)
  return value
}
function storage(event: StorageEvent) {
  if (event.key?.startsWith('litch.manager.posts:')) {
    cache.delete(event.key)
    publish()
  }
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) window.addEventListener('storage', storage)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) window.removeEventListener('storage', storage)
  }
}
export function usePostDrafts(deviceId: string, managerId: string) {
  const key = `litch.manager.posts:${JSON.stringify([deviceId, managerId])}`
  const drafts = useSyncExternalStore(subscribe, () => read(key))
  const write = (next: PostDrafts) => {
    localStorage.setItem(key, JSON.stringify(next))
    cache.set(key, next)
    publish()
  }
  const advance = (accepted: readonly { id: string; revision: number }[]) =>
    write(advancePostDrafts(read(key), accepted))
  return { drafts, write, advance }
}

/** 只跟随本次已成功交付的版本；其他变更仍要求用户重新核对。 */
export function advancePostDrafts(
  drafts: PostDrafts,
  accepted: readonly { id: string; revision: number }[],
): PostDrafts {
  const next = { ...drafts }
  for (const object of accepted) {
    const draft = next[object.id]
    if (draft) next[object.id] = { ...draft, revision: object.revision }
  }
  return next
}
