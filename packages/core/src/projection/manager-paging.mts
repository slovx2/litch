import type { ManagerPageKind, ManagerPageQuery } from '../../../protocol/src/manager-paging.mjs'

export const managerPageKey = (query: ManagerPageQuery) =>
  `${query.kind}/${query.status}/${query.order}`
export const managerPageStates: Record<ManagerPageKind, readonly string[]> = {
  decision: ['open', 'answered', 'closed', 'ignored', 'all'],
  request: ['open', 'replied', 'delivered', 'cancelled', 'all'],
  suggestion: ['pending', 'review', 'started', 'here', 'dismissed', 'withdrawn', 'expired', 'all'],
  report: ['unread', 'read', 'all'],
  item: ['pending', 'backlog', 'running', 'review', 'blocked', 'done', 'deferred', 'all'],
}
export const managerPageLabel = (kind: ManagerPageKind, status: string): string => {
  if (status === 'all' || status === 'pending') return `manager.paging.${status}`
  if (kind === 'decision') return `manager.${status}`
  if (kind === 'item') return `manager.status.${status}`
  if (kind === 'request') return `manager.request.${status}`
  if (kind === 'report') return status === 'unread' ? 'manager.reportUnread' : 'manager.reportRead'
  return `manager.paging.${status}`
}
