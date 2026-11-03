import type { ManagerChange } from '../../../protocol/src/manager.mjs'
import type { ManagerPageKind, ManagerPageQuery } from '../../../protocol/src/manager-paging.mjs'

export const managerPageKey = (query: ManagerPageQuery) =>
  `${query.kind}/${query.status}/${query.order}`
export const managerPageStates: Record<ManagerPageKind, readonly [string, ...string[]]> = {
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

/** 审计快照里的正文和选项用于版本查看；不把内部 JSON 字段名展示给用户。 */
export function managerHistorySnapshot(change: ManagerChange) {
  const snapshot = change.before ?? change.after
  if (!snapshot) return null
  const lines = [
    String(snapshot.body ?? snapshot.background ?? snapshot.description ?? snapshot.why ?? ''),
  ]
  if (Array.isArray(snapshot.options))
    for (const option of snapshot.options) {
      if (option && typeof option === 'object' && 'label' in option)
        lines.push(
          `- ${String(option.label)}${'description' in option && option.description ? `：${String(option.description)}` : ''}`,
        )
    }
  for (const field of ['basis', 'links'])
    if (Array.isArray(snapshot[field]))
      for (const link of snapshot[field]) {
        if (link && typeof link === 'object' && 'target' in link)
          lines.push(
            `- ${'label' in link && link.label ? `${String(link.label)} · ` : ''}${String(link.target)}`,
          )
      }
  return {
    title: String(snapshot.title ?? ''),
    revision: typeof snapshot.revision === 'number' ? snapshot.revision : null,
    body: lines.filter(Boolean).join('\n\n'),
  }
}
