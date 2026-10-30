import type { SessionProposalView } from './model-tree.mjs'

export interface SuggestionView {
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
