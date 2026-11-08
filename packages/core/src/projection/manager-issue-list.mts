// 经理 issue 列表的过滤、排序与计数：桌面与手机共用同一套规则（60 号设计 5.6），界面只负责画。
// 输入是协议里的 ManagerIssueHead / ManagerIssue（时间已由核心换成毫秒），不碰设备逻辑。
import type {
  ManagerIssue,
  ManagerIssueAuthorKind,
  ManagerIssueFollowUp,
  ManagerIssueHead,
  ManagerIssueKind,
  ManagerIssueOrder,
  ManagerIssueStatus,
} from '../../../protocol/src/manager-issues.mjs'

export const MANAGER_ISSUE_KINDS: readonly ManagerIssueKind[] = [
  'ordinary',
  'decision',
  'suggestion',
  'request',
  'report',
]
export const MANAGER_ISSUE_LIST_ORDERS: readonly ManagerIssueOrder[] = [
  'newest',
  'updated',
  'oldest',
  'pending',
]

/** 每种类型在过滤器里可选的状态，次序即显示次序。 */
export const MANAGER_ISSUE_STATUSES: Record<ManagerIssueKind, readonly ManagerIssueStatus[]> = {
  ordinary: ['open', 'in_progress', 'blocked', 'resolved', 'closed'],
  decision: ['open', 'answered', 'expired', 'withdrawn', 'ignored'],
  suggestion: ['pending', 'endorsed', 'started', 'dismissed', 'expired'],
  request: ['open', 'delivered', 'replied', 'ignored', 'cancelled'],
  report: ['unread', 'read'],
}

/** 界面上的过滤条件：ManagerIssueQuery 去掉经理与分页游标。kinds 为空表示全部类型。 */
export interface ManagerIssueFilter {
  kinds: ManagerIssueKind[]
  statuses: ManagerIssueStatus[]
  authors: ManagerIssueAuthorKind[]
  followUp: ManagerIssueFollowUp | 'all'
  unread: boolean
  order: ManagerIssueOrder
}

/** 默认只看普通 issue（D-100 起的控制台首屏）。 */
export const DEFAULT_MANAGER_ISSUE_FILTER: ManagerIssueFilter = {
  kinds: ['ordinary'],
  statuses: [],
  authors: [],
  followUp: 'all',
  unread: false,
  order: 'newest',
}

/** 同一组条件得到同一个键：列表缓存、阅读位置记忆都按它分。 */
export function managerIssueFilterKey(filter: ManagerIssueFilter): string {
  const sorted = <T extends string>(list: readonly T[]) => [...list].sort()
  return JSON.stringify([
    sorted(filter.kinds),
    sorted(filter.statuses),
    sorted(filter.authors),
    filter.followUp,
    filter.unread,
    filter.order,
  ])
}

/** 当前类型下还能选的状态：单一类型给它自己的状态，多类型或全部给并集（按类型次序去重）。 */
export function managerIssueStatusOptions(
  kinds: readonly ManagerIssueKind[],
): ManagerIssueStatus[] {
  const list = kinds.length ? kinds : MANAGER_ISSUE_KINDS
  return [...new Set(list.flatMap((kind) => MANAGER_ISSUE_STATUSES[kind]))]
}

/** 换类型时丢掉新类型下不存在的状态，免得过滤出一片空白又看不出原因。 */
export function withManagerIssueKinds(
  filter: ManagerIssueFilter,
  kinds: ManagerIssueKind[],
): ManagerIssueFilter {
  const options = new Set(managerIssueStatusOptions(kinds))
  return { ...filter, kinds, statuses: filter.statuses.filter((one) => options.has(one)) }
}

/**
 * 待处理：只算要用户动手的特殊类型（未答决策、待做请求、待开始建议）。
 * 普通 issue 与报告不计入（D-102：未读报告不算待处理）。
 */
export function managerIssuePending(head: Pick<ManagerIssueHead, 'kind' | 'status'>): boolean {
  if (head.kind === 'decision' || head.kind === 'request') return head.status === 'open'
  if (head.kind === 'suggestion') return head.status === 'pending' || head.status === 'endorsed'
  return false
}

/** 普通 issue 是否还开着（开放、进行中、受阻）。 */
export function managerIssueActive(head: Pick<ManagerIssueHead, 'kind' | 'status'>): boolean {
  return (
    head.kind === 'ordinary' &&
    (head.status === 'open' || head.status === 'in_progress' || head.status === 'blocked')
  )
}

export function managerIssueMatches(head: ManagerIssueHead, filter: ManagerIssueFilter): boolean {
  if (filter.kinds.length && !filter.kinds.includes(head.kind)) return false
  if (filter.statuses.length && !filter.statuses.includes(head.status)) return false
  if (filter.authors.length && !filter.authors.includes(head.author)) return false
  if (filter.followUp !== 'all' && head.followUp !== filter.followUp) return false
  if (filter.unread && !head.unread) return false
  return true
}

/** 按条件过滤并排序；时间相同按编号兜底（同一字母下数字大的更新）。 */
export function filterManagerIssues(
  heads: readonly ManagerIssueHead[],
  filter: ManagerIssueFilter,
): ManagerIssueHead[] {
  const number = (head: ManagerIssueHead) => Number(head.id.split('-')[1]) || 0
  const rows = heads.filter((head) => managerIssueMatches(head, filter))
  const at = (head: ManagerIssueHead) =>
    filter.order === 'updated' ? head.updatedAt : head.createdAt
  return rows.sort((a, b) => {
    if (filter.order === 'pending') {
      const pa = managerIssuePending(a) || (a.unread && a.kind !== 'report')
      const pb = managerIssuePending(b) || (b.unread && b.kind !== 'report')
      if (pa !== pb) return pa ? -1 : 1
    }
    const diff = filter.order === 'oldest' ? at(a) - at(b) : at(b) - at(a)
    const tie = number(a) - number(b) || a.id.localeCompare(b.id)
    return diff || (filter.order === 'oldest' ? tie : -tie)
  })
}

export interface ManagerIssueSummary {
  /** 普通 issue：还开着的、经理有新回复等我看的、跟进已暂停的（未关闭） */
  ordinary: { active: number; unread: number; paused: number; total: number }
  /** 各类型的待处理数（类别胶囊上的数字）；报告给未读数 */
  attention: Record<ManagerIssueKind, number>
  total: Record<ManagerIssueKind, number>
}

export function managerIssueSummary(heads: readonly ManagerIssueHead[]): ManagerIssueSummary {
  const zero = () =>
    Object.fromEntries(MANAGER_ISSUE_KINDS.map((kind) => [kind, 0])) as Record<
      ManagerIssueKind,
      number
    >
  const summary: ManagerIssueSummary = {
    ordinary: { active: 0, unread: 0, paused: 0, total: 0 },
    attention: zero(),
    total: zero(),
  }
  for (const head of heads) {
    summary.total[head.kind] += 1
    if (head.kind === 'ordinary') {
      summary.ordinary.total += 1
      if (managerIssueActive(head)) summary.ordinary.active += 1
      if (head.unread) summary.ordinary.unread += 1
      if (head.followUp === 'off' && head.status !== 'closed') summary.ordinary.paused += 1
      if (head.unread) summary.attention.ordinary += 1
    } else if (head.kind === 'report') {
      if (head.unread) summary.attention.report += 1
    } else if (managerIssuePending(head)) summary.attention[head.kind] += 1
  }
  return summary
}

/** 完整 issue 收成列表行；预览取正文第一段非空文字。 */
export function managerIssueHead(issue: ManagerIssue): ManagerIssueHead {
  const preview =
    issue.body
      .split(/\n\s*\n/)
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .find(Boolean) ?? ''
  return {
    id: issue.id,
    aliases: issue.aliases,
    kind: issue.kind,
    title: issue.title,
    preview: preview.length > 200 ? `${preview.slice(0, 199)}…` : preview,
    status: issue.status,
    stateGroup: issue.stateGroup,
    author: issue.author.kind,
    followUp: issue.followUp.state,
    unread: issue.unread,
    revision: issue.revision,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  }
}
