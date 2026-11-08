// issue 协议时间点统一投影为毫秒；界面通过 managerBoard 订阅缓存和独立命令读取。
import type {
  ManagerIssue,
  ManagerIssuePage,
  ManagerIssueQuery,
} from '../../protocol/src/manager-issues.mjs'

export type {
  ManagerIssue,
  ManagerIssueActivityNotification,
  ManagerIssueAuthorKind,
  ManagerIssueComment,
  ManagerIssueCommentParams,
  ManagerIssueCreateParams,
  ManagerIssueDetail,
  ManagerIssueDiscussion,
  ManagerIssueFollowParams,
  ManagerIssueFollowUp,
  ManagerIssueFollowUpState,
  ManagerIssueHead,
  ManagerIssueId,
  ManagerIssueKind,
  ManagerIssueOrder as ManagerPublicIssueOrder,
  ManagerIssuePage,
  ManagerIssueQuery,
  ManagerIssueQuickActions,
  ManagerIssueRef,
  ManagerIssueSeenParams,
  ManagerIssueStateGroup,
  ManagerIssueStatus,
  ManagerIssueTimelineEntry,
  ManagerIssueUpdateParams,
  ManagerOrdinaryStatus,
} from '../../protocol/src/manager-issues.mjs'
export interface ManagerIssuesView {
  pages: Record<string, ManagerIssuePage>
  details: Record<string, ManagerIssue>
  loading: string[]
  error: string | null
}
export function managerIssueQueryKey(query: ManagerIssueQuery): string {
  return JSON.stringify([
    query.kinds ?? ['ordinary'],
    query.statuses ?? [],
    query.authors ?? [],
    query.followUp ?? 'all',
    query.unread ?? null,
    query.order ?? 'newest',
    query.limit ?? 30,
    query.discussionsOnly ?? false,
  ])
}
