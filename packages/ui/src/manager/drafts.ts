import { useSyncExternalStore } from 'react'
import type { ManagerSubmittedAnswer } from '../../../core/src/model-manager.mts'
import {
  type ManagerDraftBoard,
  resetDecisionSelection,
} from '../../../core/src/projection/manager-drafts.mts'

export interface DecisionDraft extends ManagerSubmittedAnswer {
  question?: string
}
export type AnswerDrafts = Record<string, DecisionDraft>
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
        const draft = value as Partial<DecisionDraft>
        if (
          draft.decisionId === id &&
          /^D-\d+$/.test(id) &&
          Number.isInteger(draft.revision) &&
          (draft.optionId === null || typeof draft.optionId === 'string') &&
          typeof draft.text === 'string' &&
          (draft.question === undefined || typeof draft.question === 'string')
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
  return Object.values(drafts)
    .filter((draft) => draft.optionId !== null || draft.text.trim())
    .map(({ question: _question, ...answer }) => answer)
}

export function questionDrafts(drafts: AnswerDrafts) {
  return Object.values(drafts)
    .filter((draft) => draft.question?.trim())
    .map((draft) => ({
      decisionId: draft.decisionId,
      revision: draft.revision,
      question: draft.question?.trim() ?? '',
    }))
}

/** 放弃答案修改时保留同一决策的追问，以及其他决策的草稿。 */
export function cancelAnswerEdit(drafts: AnswerDrafts, id: string): AnswerDrafts {
  const next = { ...drafts }
  const draft = next[id]
  if (draft?.question?.trim()) next[id] = { ...draft, optionId: null, text: '' }
  else delete next[id]
  return next
}

/** 清空仅选项和空的过期草稿，其他对象与文字草稿保持原引用。 */
export function refreshAnswerDrafts(board: ManagerDraftBoard, drafts: AnswerDrafts) {
  const next = { ...drafts }
  const cleared: string[] = []
  let changed = false
  for (const [id, draft] of Object.entries(drafts)) {
    if (!resetDecisionSelection(board, draft)) continue
    if (draft.optionId !== null) cleared.push(id)
    delete next[id]
    changed = true
  }
  return { drafts: changed ? next : drafts, cleared }
}
