// 经理协议 → 界面：只转换时间点，不转换时长和审计原文。
import type {
  Manager,
  ManagerAnswersSubmitResponse,
  ManagerBoard,
  ManagerDecision,
} from '../../../protocol/src/manager.mjs'
import type { SessionSummary } from '../model.mjs'
import type {
  ManagerAnswersResult,
  ManagerBoardView,
  ManagerDecisionView,
  ManagerItemStatus,
  ManagerItemView,
  ManagerView,
  SessionManagerMark,
} from '../model-manager.mjs'

export type ManagerSessionSummary = SessionSummary & { litchManager?: SessionManagerMark }
export const managerMark = (session: SessionSummary): SessionManagerMark | null =>
  (session as ManagerSessionSummary).litchManager ?? null
const ms = (value: number | null): number | null => (value === null ? null : value * 1000)
const timed = <T extends { at: number }>(value: T): T => ({ ...value, at: value.at * 1000 })

export function projectManager(deviceId: string, manager: Manager): ManagerView {
  return {
    ...manager,
    deviceId,
    createdAt: manager.createdAt * 1000,
    updatedAt: manager.updatedAt * 1000,
    endedAt: ms(manager.endedAt),
    latestActivity: manager.latestActivity ? timed(manager.latestActivity) : null,
  }
}
export function projectManagerDecision(decision: ManagerDecision): ManagerDecisionView {
  return {
    ...decision,
    createdAt: decision.createdAt * 1000,
    updatedAt: decision.updatedAt * 1000,
    checked: decision.checked ? timed(decision.checked) : null,
    answer: decision.answer ? timed(decision.answer) : null,
    closed: decision.closed ? timed(decision.closed) : null,
  }
}
export function projectManagerBoard(deviceId: string, board: ManagerBoard): ManagerBoardView {
  return {
    ...board,
    deviceId,
    situation: board.situation ? timed(board.situation) : null,
    decisions: board.decisions.map(projectManagerDecision),
    items: board.items.map((item) => ({
      ...item,
      createdAt: item.createdAt * 1000,
      updatedAt: item.updatedAt * 1000,
      checked: item.checked ? timed(item.checked) : null,
    })),
    lines: board.lines.map((line) => ({
      ...line,
      startedAt: ms(line.startedAt),
      report: line.report ? timed(line.report) : null,
    })),
    activities: board.activities.map(timed).sort((a, b) => b.at - a.at),
    changes: board.changes.map(timed),
  }
}
export function projectManagerAnswers(result: ManagerAnswersSubmitResponse): ManagerAnswersResult {
  return {
    accepted: result.accepted.map(projectManagerDecision),
    rejected: result.rejected.map((entry) => ({
      ...entry,
      decision: entry.decision ? projectManagerDecision(entry.decision) : null,
    })),
    delivery: result.delivery,
  }
}

/** 四页共用的派生数据；不往 L0 的看板契约中添加字段。 */
export function managerBoardPages(board: ManagerBoardView) {
  const decisions = {
    pending: board.decisions.filter((d) => d.status === 'open'),
    answered: board.decisions.filter((d) => d.status === 'answered'),
    closed: board.decisions.filter((d) => d.status === 'expired' || d.status === 'withdrawn'),
  }
  const items: Record<ManagerItemStatus, ManagerItemView[]> = {
    backlog: [],
    running: [],
    review: [],
    done: [],
    deferred: [],
    blocked: [],
  }
  for (const item of board.items) items[item.status].push(item)
  const waitingForYou = board.items.filter(
    (item) => item.owner.kind === 'user' && item.status !== 'done' && item.status !== 'deferred',
  )
  return {
    overview: {
      situation: board.situation,
      stats: {
        pendingDecisions: decisions.pending.length,
        runningLines: board.lines.filter((line) => line.running).length,
        blockedItems: items.blocked.length,
        waitingForYou: waitingForYou.length,
        doneItems: items.done.length,
        totalItems: board.items.length,
      },
      blocked: items.blocked,
      waitingForYou,
      activities: [...board.activities].sort((a, b) => b.at - a.at),
    },
    decisions,
    items,
    lines: board.lines,
  }
}
export type ManagerBoardPages = ReturnType<typeof managerBoardPages>

/** 有标记的会话及其整棵子树从普通侧栏排除，父节点暂缺时仍保留标记的含义。 */
export function managerSessionIds(sessions: Iterable<SessionSummary>): Set<string> {
  const rows = [...sessions]
  const excluded = new Set(
    rows.filter((session) => managerMark(session)).map((session) => session.id),
  )
  let changed = true
  while (changed) {
    changed = false
    for (const session of rows) {
      const parent = session.lineage?.parentId ?? session.nativeLineage?.parentId
      if (parent && excluded.has(parent) && !excluded.has(session.id)) {
        excluded.add(session.id)
        changed = true
      }
    }
  }
  return excluded
}
