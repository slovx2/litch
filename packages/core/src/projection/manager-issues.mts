// 控制台议题的排序与已答决策的分块：桌面与手机共用同一套规则，界面只负责画。
import type {
  ManagerAnswer,
  ManagerClosed,
  ManagerDecisionOption,
  ManagerDecisionStatus,
} from '../../../protocol/src/manager.mjs'

/** 最新优先（默认）、最早优先、待处理优先；时间一律取发起时间，追问回复不让卡片跳动。 */
export type ManagerIssueOrder = 'newest' | 'oldest' | 'pending'
export const MANAGER_ISSUE_ORDERS: readonly ManagerIssueOrder[] = ['newest', 'oldest', 'pending']
export const DEFAULT_MANAGER_ISSUE_ORDER: ManagerIssueOrder = 'newest'

/** 读出本地存的排序；认不出的值回到默认。 */
export function parseManagerIssueOrder(value: unknown): ManagerIssueOrder {
  return MANAGER_ISSUE_ORDERS.includes(value as ManagerIssueOrder)
    ? (value as ManagerIssueOrder)
    : DEFAULT_MANAGER_ISSUE_ORDER
}

/**
 * 时间相同按输入次序兜底（输入通常按编号递增，靠后的更新）；
 * 待处理优先：先需要处理的，同组内按最新优先。
 */
export function sortManagerIssues<T>(
  rows: readonly T[],
  order: ManagerIssueOrder,
  key: (row: T) => { at: number; pending?: boolean | undefined },
): T[] {
  const keyed = rows.map((row, index) => ({ row, index, ...key(row) }))
  keyed.sort((a, b) => {
    if (order === 'pending' && Boolean(a.pending) !== Boolean(b.pending)) return a.pending ? -1 : 1
    return order === 'oldest' ? a.at - b.at || a.index - b.index : b.at - a.at || b.index - a.index
  })
  return keyed.map((entry) => entry.row)
}

export interface DecisionAnswerParts {
  /** current：已答或已关闭时的答复；previous：重新打开后留下的上次答复 */
  answerKind: 'current' | 'previous' | null
  answer: ManagerAnswer | null
  /** 答复里选中的选项；选项已被改掉时为 null */
  chosen: ManagerDecisionOption | null
  /** 没选中的选项，按原顺序 */
  others: ManagerDecisionOption[]
  closed: ManagerClosed | null
}

/** 把一个决策拆成问题之外的几块：答复、关闭记录、其他选项。 */
export function decisionAnswerParts(decision: {
  status: ManagerDecisionStatus
  options: readonly ManagerDecisionOption[]
  answer: ManagerAnswer | null
  closed: ManagerClosed | null
}): DecisionAnswerParts {
  const answer = decision.answer
  const chosen = answer?.optionId
    ? (decision.options.find((option) => option.id === answer.optionId) ?? null)
    : null
  return {
    answerKind: answer ? (decision.status === 'open' ? 'previous' : 'current') : null,
    answer,
    chosen,
    others: decision.options.filter((option) => option !== chosen),
    closed: decision.status === 'open' ? null : decision.closed,
  }
}
