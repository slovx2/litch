// 经理协议 → 界面：只转换时间点，不转换时长和审计原文。
import type {
  Manager,
  ManagerAnswersSubmitResponse,
  ManagerBoard,
  ManagerChange,
  ManagerClosed,
  ManagerDecision,
  ManagerRequest,
} from '../../../protocol/src/manager.mjs'
import type { ManagerPost } from '../../../protocol/src/manager-posts.mjs'
import type { SessionSummary } from '../model.mjs'
import type {
  ManagerAnswersResult,
  ManagerBoardView,
  ManagerDecisionView,
  ManagerItemStatus,
  ManagerItemView,
  ManagerLineView,
  ManagerView,
  SessionManagerMark,
} from '../model-manager.mjs'

export type ManagerSessionSummary = SessionSummary & { litchManager?: SessionManagerMark }
export const managerMark = (session: SessionSummary): SessionManagerMark | null =>
  (session as ManagerSessionSummary).litchManager ?? null
const ms = (value: number | null): number | null => (value === null ? null : value * 1000)
const timed = <T extends { at: number }>(value: T): T => ({ ...value, at: value.at * 1000 })

/** 待处理只计需行动的三类；报告未读仅留在报告分类（D-29）。 */
export function managerAttentionCount(
  manager: Pick<Manager, 'pendingDecisions' | 'pendingRequests' | 'pendingSuggestions'>,
): number {
  return (
    manager.pendingDecisions + (manager.pendingRequests ?? 0) + (manager.pendingSuggestions ?? 0)
  )
}

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
    ...(decision.discussion
      ? {
          discussion: { ...decision.discussion, messages: decision.discussion.messages.map(timed) },
        }
      : {}),
    createdAt: decision.createdAt * 1000,
    updatedAt: decision.updatedAt * 1000,
    checked: decision.checked ? timed(decision.checked) : null,
    answer: decision.answer ? timed(decision.answer) : null,
    closed: decision.closed ? timed(decision.closed) : null,
  }
}
export function projectManagerRequest(request: ManagerRequest): ManagerRequest {
  return {
    ...request,
    createdAt: request.createdAt * 1000,
    updatedAt: request.updatedAt * 1000,
    response: request.response ? timed(request.response) : null,
    cancelled: request.cancelled ? timed(request.cancelled) : null,
  }
}
export function projectManagerPost(post: ManagerPost): ManagerPost {
  return {
    ...post,
    createdAt: post.createdAt * 1000,
    updatedAt: post.updatedAt * 1000,
    versions: post.versions.map(timed),
    discussion: {
      ...post.discussion,
      messages: post.discussion.messages.map((q) => ({
        ...timed(q),
        ...(q.answeredAt === undefined ? {} : { answeredAt: q.answeredAt * 1000 }),
      })),
    },
  }
}
/**
 * 待定决策若是被重新打开的，找回重开前的关闭记录。变更记录按设备给的顺序（新的在前）：
 * 这个决策最近一次状态变化是从已过期或已撤回变回待定，就取变化前的 closed。
 */
export function reopenedClosure(
  decision: Pick<ManagerDecision, 'id' | 'status'>,
  changes: readonly ManagerChange[],
): ManagerClosed | null {
  if (decision.status !== 'open') return null
  for (const change of changes) {
    if (change.objectId !== decision.id || !change.before || !change.after) continue
    if (change.before.status === change.after.status) continue
    const closed = change.before.closed as ManagerClosed | null | undefined
    return change.after.status === 'open' &&
      (change.before.status === 'expired' || change.before.status === 'withdrawn') &&
      closed &&
      typeof closed.reason === 'string' &&
      typeof closed.at === 'number'
      ? closed
      : null
  }
  return null
}
/**
 * 待定决策若是经理把用户忽略的重新打开的，取那次变更的理由（why）给用户看。规则同上：只看这个决策最近一次状态变化。
 */
export function managerReopen(
  decision: Pick<ManagerDecision, 'id' | 'status'>,
  changes: readonly ManagerChange[],
): ManagerClosed | null {
  if (decision.status !== 'open') return null
  for (const change of changes) {
    if (change.objectId !== decision.id || !change.before || !change.after) continue
    if (change.before.status === change.after.status) continue
    return change.after.status === 'open' &&
      change.before.status === 'ignored' &&
      change.by === 'manager' &&
      typeof change.why === 'string'
      ? { reason: change.why, by: change.by, at: change.at }
      : null
  }
  return null
}
export function projectManagerBoard(deviceId: string, board: ManagerBoard): ManagerBoardView {
  return {
    ...board,
    ...(board.relations ? { relations: board.relations.map(timed) } : {}),
    ...(board.posts ? { posts: board.posts.map(projectManagerPost) } : {}),
    deviceId,
    situation: board.situation ? timed(board.situation) : null,
    requests: (board.requests ?? []).map(projectManagerRequest),
    decisions: board.decisions.map((decision) => {
      const view = projectManagerDecision(decision)
      const previous = reopenedClosure(decision, board.changes)
      const reopened = managerReopen(decision, board.changes)
      return {
        ...view,
        ...(previous ? { previousClosed: timed(previous) } : {}),
        ...(reopened ? { reopened: timed(reopened) } : {}),
      }
    }),
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
    ignored: board.decisions.filter((d) => d.status === 'ignored'),
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
      requests: (board.requests ?? []).filter((request) =>
        ['open', 'replied'].includes(request.status),
      ),
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

/** 工作线现在怎样：会话摘要在时以它为准（更新得更快），没有时用看板上的线状态 */
export type ManagerLineState = 'waiting' | 'error' | 'running' | 'background' | 'idle'
export interface ManagerLineRow {
  line: ManagerLineView
  state: ManagerLineState
  /** 最近动静：回报时间、会话更新时间、开线时间取最晚的；都没有是 null */
  at: number | null
}
const LINE_RANK: Record<ManagerLineState, number> = {
  waiting: 0,
  error: 0,
  running: 1,
  background: 2,
  idle: 3,
}

/**
 * 手机经理页“工作线”页签的行（35-manager 17.5）：等人、出错 → 运行中 → 后台任务 → 空闲，同组最近动静新的在前；
 * 已合并的进 ended（默认收起的“已结束”组），同样按最近动静排。
 */
export function managerLineRows(
  lines: readonly ManagerLineView[],
  summaryOf: (
    threadId: string,
  ) => Pick<SessionSummary, 'status' | 'background' | 'updatedAt'> | undefined,
): { active: ManagerLineRow[]; ended: ManagerLineRow[] } {
  const rows = lines.map((line): ManagerLineRow => {
    const summary = summaryOf(line.threadId)
    const state: ManagerLineState = summary
      ? summary.status !== 'idle'
        ? summary.status
        : (summary.background?.running ?? 0) > 0
          ? 'background'
          : 'idle'
      : line.status
    const times = [line.report?.at, summary?.updatedAt, line.startedAt].filter(
      (value): value is number => typeof value === 'number',
    )
    return { line, state, at: times.length ? Math.max(...times) : null }
  })
  const recent = (a: ManagerLineRow, b: ManagerLineRow) => (b.at ?? 0) - (a.at ?? 0)
  return {
    active: rows
      .filter((row) => row.line.merged !== true)
      .sort((a, b) => LINE_RANK[a.state] - LINE_RANK[b.state] || recent(a, b)),
    ended: rows.filter((row) => row.line.merged === true).sort(recent),
  }
}
