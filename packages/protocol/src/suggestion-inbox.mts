// 设备级建议收件箱；原提案仍由 sessionTree 管理，集中视图没有另一份持久数据。
import type { SessionProposal } from './session-tree.mjs'

export const SUGGESTIONS_LIST = 'litch/suggestions/list'
export const SUGGESTIONS_CHANGED = 'litch/suggestions/changed'
export const SUGGESTION_RETENTION_SETTING = 'sessions.suggestionRetentionDays'
/** 有限值保证 JSON 和现有 expiresAt 协议不变，单位为秒。 */
export const SUGGESTION_NEVER = 8_640_000_000_000

export interface SuggestionEntry {
  proposal: SessionProposal
  source: {
    threadId: string
    title: string
    harness: string
    cwd: string
    archived: boolean
    project: { id: string; name: string } | null
  }
  managerId: string | null
}
export interface SuggestionsSnapshot {
  suggestions: SuggestionEntry[]
}
export interface SuggestionsChanged {
  upserts: SuggestionEntry[]
  removed: string[]
}

export function suggestionExpiry(createdAt: number, days: string): number {
  return days === 'never' ? SUGGESTION_NEVER : createdAt + Number(days) * 86_400
}
