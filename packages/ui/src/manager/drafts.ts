import { useSyncExternalStore } from 'react'
import type { ManagerSubmittedAnswer } from '../../../core/src/model-manager.mts'

export type AnswerDrafts = Record<string, ManagerSubmittedAnswer>
const cache = new Map<string, AnswerDrafts>()
const listeners = new Set<() => void>()
const keyOf = (deviceId: string, managerId: string) =>
  `litch.manager.answers:${JSON.stringify([deviceId, managerId])}`
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function read(key: string): AnswerDrafts {
  const cached = cache.get(key)
  if (cached) return cached
  let drafts: AnswerDrafts = {}
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [id, value] of Object.entries(raw)) {
        if (!value || typeof value !== 'object') continue
        const draft = value as Partial<ManagerSubmittedAnswer>
        if (
          draft.decisionId === id &&
          /^D-\d+$/.test(id) &&
          Number.isInteger(draft.revision) &&
          (draft.optionId === null || typeof draft.optionId === 'string') &&
          typeof draft.text === 'string'
        ) {
          drafts[id] = draft as ManagerSubmittedAnswer
        }
      }
    }
  } catch {
    drafts = {}
  }
  cache.set(key, drafts)
  return drafts
}

/** 草稿只在桌面本地；落盘失败向页面报错，不假装已经保存。 */
export function useAnswerDrafts(deviceId: string, managerId: string) {
  const key = keyOf(deviceId, managerId)
  const drafts = useSyncExternalStore(subscribe, () => read(key))
  const write = (next: AnswerDrafts) => {
    localStorage.setItem(key, JSON.stringify(next))
    cache.set(key, next)
    for (const listener of listeners) listener()
  }
  return { drafts, write }
}

export function answeredDrafts(drafts: AnswerDrafts): ManagerSubmittedAnswer[] {
  return Object.values(drafts).filter((draft) => draft.optionId !== null || draft.text.trim())
}
