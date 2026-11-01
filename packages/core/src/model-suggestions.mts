import type { SessionProposalView } from './model-tree.mjs'

export interface SuggestionView {
  managerReview?: import('../../protocol/src/suggestion-inbox.mjs').SuggestionReview
  deviceId: string
  proposal: SessionProposalView
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
export interface SuggestionsView {
  deviceId: string
  available: boolean | null
  suggestions: SuggestionView[]
}

/** 经理标识只在设备内唯一，筛选必须同时核对设备。 */
export function filterSuggestions(
  rows: readonly SuggestionView[],
  manager: { deviceId: string; managerId: string } | null,
): readonly SuggestionView[] {
  return manager
    ? rows.filter((row) => row.deviceId === manager.deviceId && row.managerId === manager.managerId)
    : rows
}

export type SuggestionEntry =
  | { kind: 'suggestion'; row: SuggestionView }
  | { kind: 'manager'; deviceId: string; managerId: string; rows: SuggestionView[] }

/** 全局收件箱：同一设备上同一经理的整棵子树合成一项，按最近建议排序。 */
export function groupSuggestions(rows: readonly SuggestionView[]): SuggestionEntry[] {
  const entries: SuggestionEntry[] = []
  const groups = new Map<string, Extract<SuggestionEntry, { kind: 'manager' }>>()
  for (const row of [...rows].sort((a, b) => b.proposal.createdAt - a.proposal.createdAt)) {
    if (row.managerId === null) {
      entries.push({ kind: 'suggestion', row })
      continue
    }
    const key = JSON.stringify([row.deviceId, row.managerId])
    let group = groups.get(key)
    if (!group) {
      group = { kind: 'manager', deviceId: row.deviceId, managerId: row.managerId, rows: [] }
      groups.set(key, group)
      entries.push(group)
    }
    group.rows.push(row)
  }
  return entries
}

/** 普通会话照常计数；经理卡只有明确审核后进入默认列表。 */
export const reviewedSuggestion = (row: SuggestionView): boolean =>
  row.managerId === null || row.managerReview?.state === 'endorsed'
export const suggestionCount = (rows: readonly SuggestionView[]): number =>
  rows.filter(reviewedSuggestion).length
