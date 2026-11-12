// 设备级建议收件箱；原提案仍由 sessionTree 管理，集中视图没有另一份持久数据。
import type { ManagerSuggestionIssueStatus } from './manager-issues.mjs'
import type { SessionProposal } from './session-tree.mjs'

export const SUGGESTIONS_LIST = 'litch/suggestions/list'
export const SUGGESTIONS_CHANGED = 'litch/suggestions/changed'
export const SUGGESTION_RETENTION_SETTING = 'sessions.suggestionRetentionDays'
/** 有限值保证 JSON 和现有 expiresAt 协议不变，单位为秒。 */
export const SUGGESTION_NEVER = 8_640_000_000_000

export interface SuggestionReview {
  state: 'pending' | 'endorsed' | 'dismissed'
  reason: string | null
  at: number | null
}
export interface SuggestionEntry {
  managerReview?: SuggestionReview
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

/** 建议的 issue 外壳沿用提案权威状态；只有待处理提案再叠加经理审核。 */
export function managerSuggestionIssueStatus(
  status: string,
  review: SuggestionReview['state'] | null,
  own: boolean,
): ManagerSuggestionIssueStatus {
  if (status === 'pending') return review ?? (own ? 'endorsed' : 'pending')
  if (status === 'here') return 'started'
  if (status === 'withdrawn') return 'dismissed'
  return status as ManagerSuggestionIssueStatus
}
