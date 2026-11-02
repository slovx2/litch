// 手机议题的排序、分类计数与正文层级共用纯函数，保持报告未读独立于待处理；排序规则在核心，与桌面一致。
import {
  type ManagerIssueOrder,
  type ManagerView,
  managerAttentionCount,
  reviewedSuggestion,
  type SessionSummary,
  type SuggestionView,
  sortManagerIssues,
} from '@litch/core'
import type {
  Manager,
  ManagerBoard,
  ManagerDecision,
} from '../../../../../packages/protocol/src/manager.mjs'
import type { ManagerPost } from '../../../../../packages/protocol/src/manager-posts.mjs'
import {
  type ManagerStateText,
  managerStateText,
  type SessionMark,
  sessionMark,
} from '../../../../../packages/ui/src/sidebar/session-mark.ts'
import { markdownStyleOf } from '../../detail/markdownStyle'
import type { StatusKind, Theme } from '../../ui/theme'

/**
 * 经理目录一行的记号、待处理数和状态文字。记号只说经理会话自己（回合在跑、等人、出错、只剩后台任务），
 * 与会话行同一套；待处理数画成行尾等待色的计数胶囊；工作线在跑另用文字写明，不借用经理自己的“运行中”
 * （与桌面侧栏的经理行同一规则）。文字：已结束/正在结束 → 运行中 → N 条工作线运行中 → N 个后台任务正在运行 → 空闲。
 */
export function managerRowState(
  manager: Pick<
    ManagerView,
    'status' | 'runningLines' | 'pendingDecisions' | 'pendingRequests' | 'pendingSuggestions'
  >,
  summary: Pick<SessionSummary, 'status' | 'background' | 'unread'> | undefined,
): {
  mark: StatusKind
  /** 进行中经理的待处理合计（同 D-29 口径），0 不画胶囊 */
  pending: number
  text: { key: 'manager.ending' | 'manager.ended' } | ManagerStateText
} {
  // 记号和文字与桌面侧栏同一套规则（session-mark.ts）；手机不画未读，已结束画离线
  const mark: StatusKind =
    manager.status === 'ended' ? 'offline' : MOBILE_MARK[sessionMark(summary)]
  if (manager.status !== 'active')
    return { mark, pending: 0, text: { key: `manager.${manager.status}` } }
  return {
    mark,
    pending: managerAttentionCount(manager),
    text: managerStateText(summary, manager.runningLines),
  }
}

const MOBILE_MARK: Record<SessionMark, StatusKind> = {
  run: 'running',
  wait: 'waiting',
  err: 'error',
  bg: 'background',
  unread: 'idle',
  '': 'idle',
}

/** 未回答的关闭决策只能重开；有旧答案时保留修改入口，与桌面相同。 */
export function decisionActions(decision: Pick<ManagerDecision, 'status' | 'answer'>) {
  return {
    edit: decision.status === 'answered' || Boolean(decision.answer),
    reopen: decision.status === 'expired' || decision.status === 'withdrawn',
  }
}

export function issueCounts(manager: Manager | undefined) {
  return {
    decision: manager?.pendingDecisions ?? 0,
    suggestion: manager?.pendingSuggestions ?? 0,
    request: manager?.pendingRequests ?? 0,
    report: manager?.pendingReports ?? 0,
  }
}
/** 议题是否需要处理：待定决策、待做请你做、未阅报告、经理已审核待开始的建议。 */
export function issuePending(
  post: ManagerPost,
  board: Pick<ManagerBoard, 'decisions' | 'requests'>,
  suggestions: readonly SuggestionView[],
): boolean {
  if (post.kind === 'decision')
    return board.decisions.some((d) => d.id === post.id && d.status === 'open')
  if (post.kind === 'request')
    return (board.requests ?? []).some((r) => r.id === post.id && r.status === 'open')
  if (post.kind === 'report') return Boolean(post.unread)
  const row = suggestions.find((s) => s.proposal.id === post.proposalId)
  return row ? reviewedSuggestion(row) : false
}
/** 按用户选的排序排列议题；时间取发起时间（与桌面同一个纯函数）。 */
export function orderedIssues(
  posts: readonly ManagerPost[],
  board: Pick<ManagerBoard, 'decisions' | 'requests'>,
  order: ManagerIssueOrder,
  suggestions: readonly SuggestionView[] = [],
) {
  return sortManagerIssues(posts, order, (post) => ({
    at: post.createdAt,
    pending: issuePending(post, board, suggestions),
  }))
}
/** 列表行里只放一行纯文字：取第一行非空内容，去掉常见 Markdown 记号。 */
export function plainLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? ''
  return line
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .trim()
}

/** 收起的长动态只渲染前几行源文字；切在代码块中间时补上结束标记。 */
export function collapsedMarkdown(text: string, lines: number): string | null {
  const all = text.split('\n')
  if (all.length <= lines) return null
  const head = all.slice(0, lines)
  const fences = head.filter((l) => l.trimStart().startsWith('```')).length
  return `${head.join('\n')}${fences % 2 ? '\n```' : ''}`
}

export function issueMarkdownStyle(theme: Theme) {
  const base = markdownStyleOf(theme)
  const max = theme.font.size.title - 1
  return {
    ...base,
    h1: { ...base.h1, fontSize: max, lineHeight: max + 8 },
    h2: { ...base.h2, fontSize: max, lineHeight: max + 8 },
    h3: {
      ...base.h3,
      fontSize: Math.min(max, theme.font.size.body),
      lineHeight: theme.font.size.body + 8,
    },
    h4: { ...base.h4, fontSize: theme.font.size.body },
    h5: { ...base.h5, fontSize: theme.font.size.body },
    h6: { ...base.h6, fontSize: theme.font.size.body },
  }
}
