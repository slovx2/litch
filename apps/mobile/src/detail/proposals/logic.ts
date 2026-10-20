// 建议任务（模型提的子会话提案）在手机上的纯逻辑：对话里哪条工具调用画成提案卡、各画哪几张，
// offer 卡（“新会话 / 在这里做”）和交接（hand_off）怎么认，列表的排法，“改了再开始”发哪些改动，
// 注入的会话事件算哪一种。不依赖 React，单元测试直接跑。
// 表单的初值和改动用桌面界面那一份（packages/ui/src/tree/spawn-form.ts），这里只补桌面那份还没有的“完成后唤醒”。
import {
  type ProposalOverrides,
  type ProposalStatus,
  proposalStatus,
  proposedBy,
  type SessionEventView,
  type SessionProposalView,
  type ToolCallItem,
  type ToolPart,
} from '@litch/core'
import { CLIENT_TOOL_NAMESPACE } from '../../../../../packages/protocol/src/client-tools.mts'
import { SESSION_TOOL } from '../../../../../packages/protocol/src/client-tools-sessions.mts'
import {
  overridesOf,
  type SpawnFields,
  type SpawnParent,
} from '../../../../../packages/ui/src/tree/spawn-form.ts'
import type { Key } from '../../ui/i18n'

/** 简报长到要折起来：超过这么多字，或者超过这么多行（和桌面卡片同一个门槛） */
export const LONG_BRIEF = 160
const LONG_LINES = 3

export const isLongBrief = (prompt: string): boolean =>
  prompt.length > LONG_BRIEF || prompt.split('\n').length > LONG_LINES

/** litch_sessions 的收尾调用（每回合最后一次，一次可带几条建议，每条成一张提案） */
export const isWrapUp = (item: ToolCallItem): boolean =>
  item.source === CLIENT_TOOL_NAMESPACE.sessions && item.tool === SESSION_TOOL.wrapUp

/** 参数、结果排成的文字连起来（核心把 JSON 排成了给人看的文本，太长的只留头尾） */
const textOf = (parts: readonly ToolPart[]): string =>
  parts.map((part) => (part.kind === 'text' ? part.text : '')).join('')

/** 文字里某个字符串字段的值（参数太长被截过时整段不是合法 JSON，按字段找）。没有是 null */
function field(text: string, name: string): string | null {
  const match = new RegExp(`"${name}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(text)
  if (!match?.[1]) return null
  try {
    const value: unknown = JSON.parse(match[1])
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

/** litch_sessions.start 带 initiation offer 的那次调用：只有标题，等用户选“新会话”还是“在这里做” */
export const isOfferCall = (item: ToolCallItem): boolean =>
  item.spawned !== undefined && field(textOf(item.input), 'initiation') === 'offer'

/**
 * 一条工具调用要画成的提案卡：收尾调用按提案上记的 callId 对上（可能几张）；litch_sessions.start 降成提案的
 * 按结果里的提案号对上，列表里还没有它时照调用时给的画（proposal 为 null）。offer 的调用在用户选之前没有结果，
 * 按 callId 对上；提案还没到时也先画一张（proposal 为 null，没有按钮）。
 * 返回 null 是这条照普通工具调用画；返回空数组是这条不画（没带建议的收尾，或者建议一张都没成）
 */
export function cardsOf(
  item: ToolCallItem,
  proposals: readonly SessionProposalView[],
): (SessionProposalView | null)[] | null {
  if (isWrapUp(item)) return proposals.filter((proposal) => proposedBy(proposal, item.id))
  if (!item.spawned) return null
  const byCall = proposals.find((proposal) => proposedBy(proposal, item.id)) ?? null
  const proposalId = item.spawned.proposalId
  if (!proposalId) return byCall || isOfferCall(item) ? [byCall] : null
  return [proposals.find((proposal) => proposal.id === proposalId) ?? byCall]
}

/** offer 卡的三种状态：等用户选、选了新会话等模型补简报、选了在这里做 */
export const isOfferStatus = (status: ProposalStatus): boolean =>
  status === 'offered' || status === 'chosen' || status === 'here'

/** litch_sessions.hand_off：把做到一半的任务交给分叉会话（不出卡，立刻开始） */
export interface HandOff {
  /** 交出去的任务叫什么 */
  title: string
  /** 起出来的分叉会话。还没有结果是 null */
  threadId: string | null
}

/** 一条工具调用是不是交接，是就取标题和分叉会话。失败、被拒的照普通工具调用画（错误原因在那里），是 null */
export function handOffOf(item: ToolCallItem): HandOff | null {
  if (item.source !== CLIENT_TOOL_NAMESPACE.sessions || item.tool !== SESSION_TOOL.handOff)
    return null
  if (item.status === 'failed' || item.status === 'declined' || item.error) return null
  return {
    title: field(textOf(item.input), 'title') ?? '',
    threadId: field(textOf(item.output), 'thread_id'),
  }
}

/** 还没了结的：等用户开始、等用户选、选了新会话等模型补简报 */
const isOpen = (status: ProposalStatus): boolean =>
  status === 'pending' || status === 'offered' || status === 'chosen'

/** 等着用户动手的：等开始的、等选的（顶上那一条和角标数的是这些） */
export const needsUser = (status: ProposalStatus): boolean =>
  status === 'pending' || status === 'offered'

/** 列表的排法：没了结的在上（先提的在前），了结的在下（刚了结的在前） */
export function arrange(
  list: readonly SessionProposalView[],
  now: number,
): { pending: SessionProposalView[]; settled: SessionProposalView[] } {
  const pending = list.filter((proposal) => isOpen(proposalStatus(proposal, now)))
  const settled = list
    .filter((proposal) => !isOpen(proposalStatus(proposal, now)))
    .sort(
      (a, b) =>
        (b.settledAt ?? b.expiresAt) - (a.settledAt ?? a.expiresAt) || b.createdAt - a.createdAt,
    )
  return { pending, settled }
}

/** 等着用户开始或选的有几张 */
export const pendingCount = (list: readonly SessionProposalView[], now: number): number =>
  list.reduce((n, proposal) => n + (needsUser(proposalStatus(proposal, now)) ? 1 : 0), 0)

/** 等着的提案里最早过期的那一刻（毫秒）；没有是 null。到点重画一次，卡片从“等你开始”变成“过期了” */
export function nextExpiry(list: readonly SessionProposalView[], now: number): number | null {
  let next: number | null = null
  for (const proposal of list) {
    if (proposal.status !== 'pending' || proposal.expiresAt <= now) continue
    if (next === null || proposal.expiresAt < next) next = proposal.expiresAt
  }
  return next
}

/** 每种状态的那句话。offer 卡的三种是手机端自己的文案，别的用桌面的 */
export const STATUS_TEXT = {
  pending: 'proposal.state.pending',
  offered: 'proposals.state.offered',
  chosen: 'proposals.state.chosen',
  here: 'proposals.state.here',
  started: 'proposal.state.started',
  dismissed: 'proposal.state.dismissed',
  withdrawn: 'proposal.state.withdrawn',
  expired: 'proposal.state.expired',
} as const satisfies Record<ProposalStatus, Key>

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
