// 手机议题的排序、分类计数与正文层级共用纯函数，保持报告未读独立于待处理。
import type { Manager, ManagerDecision } from '../../../../../packages/protocol/src/manager.mjs'
import type { ManagerPost } from '../../../../../packages/protocol/src/manager-posts.mjs'
import { markdownStyleOf } from '../../detail/markdownStyle'
import type { Theme } from '../../ui/theme'

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
export function orderedIssues(
  posts: readonly ManagerPost[],
  decisions: readonly ManagerDecision[],
) {
  const order = (id: string) => {
    const status = decisions.find((d) => d.id === id)?.status
    return status === 'open' ? 0 : status === 'answered' ? 1 : 2
  }
  return [...posts].sort((a, b) =>
    a.kind === 'decision' && b.kind === 'decision' ? order(a.id) - order(b.id) : 0,
  )
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
