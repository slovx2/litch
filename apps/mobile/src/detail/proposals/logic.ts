// 建议任务（模型提的子会话提案）在手机上的纯逻辑：对话里哪条工具调用画成提案卡、各画哪几张，
// 列表的排法，“改了再开始”发哪些改动，注入的会话事件算哪一种。不依赖 React，单元测试直接跑。
// 表单的初值和改动用桌面界面那一份（packages/ui/src/tree/spawn-form.ts），这里只补桌面那份还没有的“完成后唤醒”。
import {
  type ProposalOverrides,
  type ProposalStatus,
  proposalStatus,
  type SessionEventView,
  type SessionProposalView,
  type ToolCallItem,
} from '@litch/core'
import { CLIENT_TOOL_NAMESPACE } from '../../../../../packages/protocol/src/client-tools.mts'
import { SESSION_TOOL } from '../../../../../packages/protocol/src/client-tools-sessions.mts'
import {
  overridesOf,
  type SpawnFields,
  type SpawnParent,
} from '../../../../../packages/ui/src/tree/spawn-form.ts'

/** 简报长到要折起来：超过这么多字，或者超过这么多行（和桌面卡片同一个门槛） */
export const LONG_BRIEF = 160
const LONG_LINES = 3

export const isLongBrief = (prompt: string): boolean =>
  prompt.length > LONG_BRIEF || prompt.split('\n').length > LONG_LINES

/** litch_sessions 的收尾调用（每回合最后一次，一次可带几条建议，每条成一张提案） */
export const isWrapUp = (item: ToolCallItem): boolean =>
  item.source === CLIENT_TOOL_NAMESPACE.sessions && item.tool === SESSION_TOOL.wrapUp

/**
 * 一条工具调用要画成的提案卡：收尾调用按提案上记的 callId 对上（可能几张）；litch_sessions.start 降成提案的
 * 按结果里的提案号对上，列表里还没有它时照调用时给的画（proposal 为 null）。
 * 返回 null 是这条照普通工具调用画；返回空数组是这条不画（没带建议的收尾，或者建议一张都没成）
 */
export function cardsOf(
  item: ToolCallItem,
  proposals: readonly SessionProposalView[],
): (SessionProposalView | null)[] | null {
  if (isWrapUp(item)) return proposals.filter((proposal) => proposal.callId === item.id)
  const proposalId = item.spawned?.proposalId
  if (!proposalId) return null
  return [
    proposals.find((proposal) => proposal.id === proposalId) ??
      proposals.find((proposal) => proposal.callId === item.id) ??
      null,
  ]
}

/** 列表的排法：等着的在上（先提的在前），了结的在下（刚了结的在前） */
export function arrange(
  list: readonly SessionProposalView[],
  now: number,
): { pending: SessionProposalView[]; settled: SessionProposalView[] } {
  const pending = list.filter((proposal) => proposalStatus(proposal, now) === 'pending')
  const settled = list
    .filter((proposal) => proposalStatus(proposal, now) !== 'pending')
    .sort(
      (a, b) =>
        (b.settledAt ?? b.expiresAt) - (a.settledAt ?? a.expiresAt) || b.createdAt - a.createdAt,
    )
  return { pending, settled }
}

/** 还等着开始的有几张 */
export const pendingCount = (list: readonly SessionProposalView[], now: number): number =>
  list.reduce((n, proposal) => n + (proposalStatus(proposal, now) === 'pending' ? 1 : 0), 0)

/** 等着的提案里最早过期的那一刻（毫秒）；没有是 null。到点重画一次，卡片从“等你开始”变成“过期了” */
export function nextExpiry(list: readonly SessionProposalView[], now: number): number | null {
  let next: number | null = null
  for (const proposal of list) {
    if (proposal.status !== 'pending' || proposal.expiresAt <= now) continue
    if (next === null || proposal.expiresAt < next) next = proposal.expiresAt
  }
  return next
}

/** 每种状态的那句话（桌面的文案键） */
export const STATUS_TEXT = {
  pending: 'proposal.state.pending',
  started: 'proposal.state.started',
  dismissed: 'proposal.state.dismissed',
  withdrawn: 'proposal.state.withdrawn',
  expired: 'proposal.state.expired',
} as const satisfies Record<ProposalStatus, string>

/** “改了再开始”发的改动：和桌面同一份算法（含“完成后唤醒”）。什么都没改是空对象 */
export function overridesFor(
  fields: SpawnFields,
  parent: SpawnParent,
  proposal: SessionProposalView,
): ProposalOverrides {
  return overridesOf(fields, parent, proposal)
}

/** 注入的会话事件是哪一种：notes 带回报，wake 是唤醒回合，remind 是提醒收尾 */
export function eventKind(event: SessionEventView): SessionEventView['kind'] {
  return event.kind
}
