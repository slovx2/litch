// 普通 issue 的“下一步在谁”：按事实派生，不落库。
// 规则全在这个纯函数里，顺序就是优先级；输入由 ManagerIssues 从历史表、关系和会话树收集。
import {
  MANAGER_ISSUE_STALE_SECONDS,
  type ManagerIssueFollowUp,
  type ManagerIssueStatus,
  type ManagerIssueWaiting,
  type ManagerIssueWaitingOn,
} from '../../protocol/src/manager-issues.mjs'

/** 历史表里的一行：库内顺序和时间（秒） */
export interface IssueHistoryMark {
  seq: number
  at: number
}

export interface IssueWaitingFacts {
  status: ManagerIssueStatus
  followUp: ManagerIssueFollowUp
  /** 用户最后一次“说话的动作”：新建、评论、改评论、改标题或正文 */
  lastUserTalk: IssueHistoryMark | null
  /** 经理最后一次任何动作（回复、改状态、开关跟进、标记……） */
  lastManager: IssueHistoryMark | null
  /** 这条 issue 最近一条历史记录的时间，不论谁 */
  lastAny: number | null
  /** 经理的显式标记；用户动作时已在写入处清掉，这里在就有效 */
  marked: { on: ManagerIssueWaitingOn; at: number } | null
  /** 关联的工作线：是否在跑、最近一次回合开始或回报的时间 */
  lines: readonly { running: boolean; lastActive: number | null }[]
  /** 经理会话正在跑的回合的开始时间；没在跑为 null */
  managerTurnStartedAt: number | null
  now: number
}

const OPEN: readonly ManagerIssueStatus[] = ['open', 'in_progress', 'blocked']

/** 结束的 X-n 返回 null（没有“下一步”）。 */
export function issueWaiting(facts: IssueWaitingFacts): ManagerIssueWaiting | null {
  if (!OPEN.includes(facts.status)) return null
  const since = Math.max(
    facts.lastAny ?? 0,
    facts.marked?.at ?? 0,
    ...facts.lines.map((line) => line.lastActive ?? 0),
  )
  const result = (on: ManagerIssueWaitingOn, why: ManagerIssueWaiting['why']) => ({
    on,
    why,
    since,
  })
  // 1a 关联工作线在跑；1b 经理本回合里动过这条
  if (facts.lines.some((line) => line.running)) return result('agent', 'line')
  if (
    facts.managerTurnStartedAt !== null &&
    facts.lastManager &&
    facts.lastManager.at >= facts.managerTurnStartedAt
  )
    return result('agent', 'turn')
  // 4 跟进暂停：经理不会再动
  if (facts.followUp === 'off') return result('user', 'paused')
  const followed = (why: 'marked' | 'user'): ManagerIssueWaiting =>
    facts.now - since > MANAGER_ISSUE_STALE_SECONDS
      ? { on: 'user', why, stale: true, since }
      : result('agent', why)
  // 5 经理的显式标记，覆盖受阻和最后发言
  if (facts.marked)
    return facts.marked.on === 'agent' ? followed('marked') : result('user', 'marked')
  // 6 受阻：经理写明了在等什么、何时复查，球不在用户手上；不算卡住
  if (facts.status === 'blocked') return result('agent', 'blocked')
  // 2 用户最后发言、跟进开着：经理会被叫醒；3 其余等用户
  if (facts.lastUserTalk && facts.lastUserTalk.seq > (facts.lastManager?.seq ?? -1))
    return followed('user')
  return result('user', 'manager')
}
