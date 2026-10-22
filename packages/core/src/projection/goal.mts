// 持续目标的投影（model-goal.mts）：协议的 ThreadGoal → SessionGoalView。
// 目标是对面发来的，不能只靠类型：形状不对的当没有。协议里的时间是秒，界面这边一律毫秒。
import type { ItemView, TurnView } from '../model.mjs'
import type { GoalReachedView, GoalStatus, SessionGoalView } from '../model-goal.mjs'

const STATUSES: readonly string[] = [
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
]

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

export function projectGoal(raw: unknown): SessionGoalView | null {
  if (!raw || typeof raw !== 'object') return null
  const goal = raw as Record<string, unknown>
  if (typeof goal.objective !== 'string' || !goal.objective) return null
  if (!STATUSES.includes(goal.status as string)) return null
  const budget = goal.tokenBudget
  return {
    objective: goal.objective,
    status: goal.status as GoalStatus,
    tokenBudget: typeof budget === 'number' && budget > 0 ? budget : null,
    tokensUsed: count(goal.tokensUsed),
    timeUsedSeconds: count(goal.timeUsedSeconds),
    createdAt: count(goal.createdAt) * 1000,
    updatedAt: count(goal.updatedAt) * 1000,
  }
}

/** 目标还会自己接着做（侧栏、输入框上方要提醒的那种）：在做的。别的状态都停着，等人处理 */
export const goalPursuing = (goal: SessionGoalView | null | undefined): boolean =>
  goal?.status === 'active'

/** 停下来要人看一眼的：受阻、用量到顶、预算用完 */
export const goalStalled = (goal: SessionGoalView | null | undefined): boolean =>
  goal?.status === 'blocked' || goal?.status === 'usageLimited' || goal?.status === 'budgetLimited'

/**
 * 对面没说来历、看上去是续跑出来的回合：会话有目标，回合里没有用户消息，模型说了话。
 * 原生 codex 的续跑回合不带来历（它的 turn_trigger 不进协议），靠这个认；Claude 入口自己带着 goal
 */
export function looksLikeGoalTurn(turn: TurnView, items: Record<string, ItemView>): boolean {
  if (turn.origin) return false
  let spoke = false
  for (const id of turn.itemIds) {
    const kind = items[id]?.kind
    if (kind === 'userMessage') return false
    if (kind === 'agentMessage') spoke = true
  }
  return spoke
}

/**
 * 这个回合的最后一条回答下面要不要写“目标已达成 · 用时 N”：达成目标的就是这个回合，而且回合已经结束了
 * （达成是回合里模型调工具报的，那时回合还在跑）。要写时给出目标一共用了多少毫秒，不写是 null
 */
export function goalReachedIn(
  reached: GoalReachedView | null | undefined,
  turn: Pick<TurnView, 'id' | 'status'> | null | undefined,
): number | null {
  if (!reached || !turn || reached.turnId !== turn.id || turn.status === 'running') return null
  return reached.timeUsedSeconds * 1000
}
