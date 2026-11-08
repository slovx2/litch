// 经理 issue 列表的过滤条件：桌面与手机共用（60 号设计 5.6）。过滤、排序、分页都在设备上做，
// 这里只把界面上的条件换成 ManagerIssueQuery；缓存按 managerIssueQueryKey(query) 分页，所以数组按固定次序给。

import type {
  ManagerIssue,
  ManagerIssueAuthorKind,
  ManagerIssueFollowUp,
  ManagerIssueHead,
  ManagerIssueKind,
  ManagerIssueOrder,
  ManagerIssueQuery,
  ManagerIssueStatus,
} from '../../../protocol/src/manager-issues.mjs'
import { managerIssueQueryKey } from '../model-manager-issues.mjs'

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
  discussionsOnly?: boolean
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
    filter.discussionsOnly ?? false,
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

const inOrder = <T extends string>(order: readonly T[], list: readonly T[]): T[] =>
  order.filter((one) => list.includes(one))
const ALL_STATUSES = managerIssueStatusOptions(MANAGER_ISSUE_KINDS)

/** 界面条件换成设备查询；kinds 为空表示全部类型。只读未读时才带 unread（不带表示不限）。 */
export function managerIssueQuery(
  managerId: string,
  filter: ManagerIssueFilter,
  limit?: number,
): ManagerIssueQuery {
  return {
    managerId,
    ...(filter.discussionsOnly ? { discussionsOnly: true } : {}),
    kinds: filter.kinds.length
      ? inOrder(MANAGER_ISSUE_KINDS, filter.kinds)
      : [...MANAGER_ISSUE_KINDS],
    statuses: inOrder(ALL_STATUSES, filter.statuses),
    authors: inOrder(['user', 'manager'], filter.authors),
    followUp: filter.followUp,
    ...(filter.unread ? { unread: true } : {}),
    order: filter.order,
    ...(limit === undefined ? {} : { limit }),
  }
}

/** 这组条件在缓存里的页键（加载更多会并进同一页）。 */
export function managerIssuePageKey(managerId: string, filter: ManagerIssueFilter): string {
  return managerIssueQueryKey(managerIssueQuery(managerId, filter))
}

/** 普通 issue 还开着的三种状态。 */
export const MANAGER_ISSUE_ACTIVE: readonly ManagerIssueStatus[] = [
  'open',
  'in_progress',
  'blocked',
]

/**
 * 概览上普通 issue 的三个数：还开着的、经理有新回复等我看的、跟进已暂停的（还开着）。
 * 各是一条只取一行的查询，数字用 total；点数字进控制台带上同一组条件。
 */
export const MANAGER_ISSUE_SUMMARY_FILTERS = {
  active: {
    ...DEFAULT_MANAGER_ISSUE_FILTER,
    discussionsOnly: true,
    statuses: [...MANAGER_ISSUE_ACTIVE],
  },
  unread: { ...DEFAULT_MANAGER_ISSUE_FILTER, discussionsOnly: true, unread: true },
  paused: {
    ...DEFAULT_MANAGER_ISSUE_FILTER,
    discussionsOnly: true,
    statuses: [...MANAGER_ISSUE_ACTIVE],
    followUp: 'off',
  },
} satisfies Record<string, ManagerIssueFilter>
export type ManagerIssueSummaryKey = keyof typeof MANAGER_ISSUE_SUMMARY_FILTERS

/** 各类型要我处理的（类别胶囊上的数字）：普通 issue 给未读，报告给未读，其余给待处理状态。 */
export const MANAGER_ISSUE_ATTENTION_FILTERS: Record<ManagerIssueKind, ManagerIssueFilter> = {
  ordinary: { ...DEFAULT_MANAGER_ISSUE_FILTER, unread: true },
  decision: { ...DEFAULT_MANAGER_ISSUE_FILTER, kinds: ['decision'], statuses: ['open'] },
  suggestion: {
    ...DEFAULT_MANAGER_ISSUE_FILTER,
    kinds: ['suggestion'],
    statuses: ['pending', 'endorsed'],
  },
  request: { ...DEFAULT_MANAGER_ISSUE_FILTER, kinds: ['request'], statuses: ['open'] },
  report: { ...DEFAULT_MANAGER_ISSUE_FILTER, kinds: ['report'], unread: true },
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
