// 模拟核心里的持续目标（thread/goal/*，model-goal.mts），照原生 codex 的样子演：
// 设下目标（active）后，会话空闲时 harness 自己开续跑回合（来历 goal，没有用户消息），每轮回一句话、记一笔用量；
// 第三轮模型报做完了（complete），照客户端的规矩马上清掉、在那一轮回答下面写用时。设了预算的，用量到了预算就停在 budgetLimited。
// 用户暂停（paused）就不再续跑，继续（active）接着跑；用户自己发的消息照常开回合，结束后接着续跑。
// 用户打断续跑的回合，目标跟着暂停（官方的终端界面这样做：打断就是不想让它接着跑了）。
import type { SessionOp } from '../channel/protocol.mjs'
import { ChannelError } from '../channel/protocol.mjs'
import type { SessionView } from '../model.mjs'
import type { GoalChange, SessionGoalView } from '../model-goal.mjs'
import type { SampleLang } from './sample-text.mjs'

/** 空闲多久开下一轮续跑（按模拟的时钟） */
export const GOAL_CONTINUE_MS = 1500
/** 每轮续跑记多少词元 */
export const GOAL_ROUND_TOKENS = 1200
/** 第几轮模型报做完了 */
export const GOAL_ROUNDS = 3

const TEXT = {
  'zh-CN': {
    round: (n: number, objective: string) =>
      `第 ${n} 轮：接着做「${objective}」，看了现在的状态，又往前推进了一步。`,
    done: (objective: string) => `「${objective}」做完了，逐项核对过，标记目标完成。`,
  },
  en: {
    round: (n: number, objective: string) =>
      `Round ${n}: kept working on "${objective}", checked the current state and moved it forward.`,
    done: (objective: string) =>
      `"${objective}" is done. Checked every requirement and marked the goal complete.`,
  },
} as const

export interface MockGoalHost {
  lang: SampleLang
  now(): number
  setTimer(run: () => void, ms: number): () => void
  apply(view: SessionView, ops: SessionOp[]): void
  /** 在回合里流出一段回答，流完回合结束 */
  reply(view: SessionView, turnId: string, text: string): void
  /** 会话现在有没有回合在跑 */
  busy(view: SessionView): boolean
  /** 续跑回合开始了：侧栏摘要改成在跑 */
  started(view: SessionView): void
  nextId(prefix: string): string
}

export interface MockGoal {
  set(view: SessionView, change: GoalChange): void
  clear(view: SessionView): void
  /** 一个回合结束了（模拟核心的 endTurn 调）。回合开始时就在续跑的、被打断的，目标暂停 */
  turnEnded(view: SessionView, turnId: string, status: 'completed' | 'interrupted' | 'failed'): void
}

export function createMockGoal(host: MockGoalHost): MockGoal {
  const text = TEXT[host.lang]
  /** 会话 → 第几轮续跑、等着开下一轮的计时器、在跑的续跑回合 */
  const runs = new Map<
    SessionView,
    { rounds: number; timer: (() => void) | null; turnId: string | null }
  >()
  const stateOf = (view: SessionView) => {
    let state = runs.get(view)
    if (!state) {
      state = { rounds: 0, timer: null, turnId: null }
      runs.set(view, state)
    }
    return state
  }

  const put = (view: SessionView, goal: SessionGoalView | null) =>
    host.apply(view, [{ op: 'session.goal', goal }])

  const patch = (view: SessionView, next: Partial<SessionGoalView>) => {
    if (!view.goal) return
    put(view, { ...view.goal, ...next, updatedAt: host.now() })
  }

  const cancel = (view: SessionView) => {
    const state = stateOf(view)
    state.timer?.()
    state.timer = null
  }

  /** 空闲、目标在做：过一会儿开一轮续跑 */
  const schedule = (view: SessionView) => {
    const state = stateOf(view)
    if (state.timer || view.goal?.status !== 'active') return
    state.timer = host.setTimer(() => {
      state.timer = null
      if (view.goal?.status !== 'active' || host.busy(view)) return
      const turnId = host.nextId('goal')
      state.turnId = turnId
      state.rounds++
      host.apply(view, [
        {
          op: 'turn.add',
          turn: {
            id: turnId,
            status: 'running',
            itemIds: [],
            startedAt: host.now(),
            durationMs: null,
            error: null,
            origin: 'goal',
          },
        },
      ])
      host.started(view)
      const objective = view.goal.objective
      host.reply(
        view,
        turnId,
        state.rounds >= GOAL_ROUNDS ? text.done(objective) : text.round(state.rounds, objective),
      )
    }, GOAL_CONTINUE_MS)
  }

  return {
    set(view, change) {
      const now = host.now()
      const objective = change.objective?.trim()
      if (!view.goal && !objective) throw new ChannelError('rejected', '还没有目标，要先写目标')
      const fresh = !view.goal || (objective !== undefined && view.goal.status === 'complete')
      if (fresh) stateOf(view).rounds = 0
      const base: SessionGoalView =
        view.goal && !fresh
          ? view.goal
          : {
              objective: objective ?? '',
              status: 'active',
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: now,
              updatedAt: now,
            }
      // 新设的目标：上一个达成的那一句不再写
      if (fresh && view.goalReached)
        host.apply(view, [{ op: 'session.goalReached', reached: null }])
      put(view, {
        ...base,
        ...(objective ? { objective } : {}),
        ...(change.status ? { status: change.status } : {}),
        ...(change.tokenBudget !== undefined ? { tokenBudget: change.tokenBudget } : {}),
        updatedAt: now,
      })
      if (view.goal?.status === 'active') {
        if (!host.busy(view)) schedule(view)
      } else cancel(view)
    },
    clear(view) {
      cancel(view)
      runs.delete(view)
      if (view.goal) put(view, null)
    },
    turnEnded(view, turnId, status) {
      const state = runs.get(view)
      const goal = view.goal
      if (!state || !goal) return
      const ownTurn = state.turnId === turnId
      if (ownTurn) {
        state.turnId = null
        const turn = view.turns.find((entry) => entry.id === turnId)
        const seconds = Math.round((turn?.durationMs ?? 0) / 1000)
        const tokensUsed = goal.tokensUsed + GOAL_ROUND_TOKENS
        let next: SessionGoalView['status'] = goal.status
        if (status === 'interrupted') next = 'paused'
        else if (status === 'failed') next = 'blocked'
        else if (goal.tokenBudget !== null && tokensUsed >= goal.tokenBudget) next = 'budgetLimited'
        else if (state.rounds >= GOAL_ROUNDS) next = 'complete'
        const timeUsedSeconds = goal.timeUsedSeconds + seconds
        if (goal.status === 'active' && next === 'complete') {
          // 达成了：照客户端的规矩（device/live.mts 的 reachGoal）马上清掉，在这一轮的回答下面写用时
          runs.delete(view)
          host.apply(view, [
            { op: 'session.goal', goal: null },
            {
              op: 'session.goalReached',
              reached: { turnId, objective: goal.objective, timeUsedSeconds },
            },
          ])
          return
        }
        patch(view, {
          tokensUsed,
          timeUsedSeconds,
          status: goal.status === 'active' ? next : goal.status,
        })
      }
      schedule(view)
    },
  }
}
