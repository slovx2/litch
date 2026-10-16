import { ProtocolError, submissionHash } from './protocol-contract.mjs'
import type { SessionStore } from './store.mjs'
import { patchThreadGoal, type ThreadGoal } from './thread-goals.mjs'
import { newId, nowSeconds } from './util.mjs'

export interface GoalLedger {
  generation: string
  elapsedMs: number
  runningTurnId: string | null
  activeSinceMs: number | null
  halted: boolean
  // 原生消息累计值：分块/重复投递只计增量，重启不重复扣费。
  usage: Record<string, number>
}
export interface GoalState {
  goal: ThreadGoal | null
  ledger: GoalLedger
}
export function emptyGoalLedger(): GoalLedger {
  return {
    generation: newId(),
    elapsedMs: 0,
    runningTurnId: null,
    activeSinceMs: null,
    halted: false,
    usage: {},
  }
}

export class GoalController {
  private readonly store: SessionStore
  constructor(store: SessionStore) {
    this.store = store
  }

  private settle(state: GoalState): void {
    const now = Date.now()
    if (state.ledger.activeSinceMs !== null) {
      if (state.goal?.status === 'active') {
        state.ledger.elapsedMs += Math.max(0, now - state.ledger.activeSinceMs)
        state.goal.timeUsedSeconds = Math.floor(state.ledger.elapsedMs / 1000)
        state.goal.updatedAt = nowSeconds()
      }
      state.ledger.activeSinceMs = now
    }
  }

  private clock(state: GoalState): void {
    state.ledger.activeSinceMs =
      state.goal?.status === 'active' && state.ledger.runningTurnId ? Date.now() : null
  }

  patch(threadId: string, params: Record<string, unknown>): ThreadGoal {
    return this.store.mutateGoalState(threadId, (state) => {
      // 先校验，无效请求不更新时间、目标或账本。
      const next = patchThreadGoal(threadId, state.goal, params)
      const fresh = state.goal === null
      // 这几处都跑在 mutateGoalState 的事务里，只问回合的状态（turnStatus）：读整个回合会先把记着的
      // 内容写进库，事务一回滚就跟着丢了
      if (
        state.ledger.runningTurnId &&
        this.store.turnStatus(state.ledger.runningTurnId) !== 'inProgress'
      ) {
        state.ledger.runningTurnId = null
        state.ledger.activeSinceMs = null
      }
      this.settle(state)
      next.timeUsedSeconds = state.goal?.timeUsedSeconds ?? 0
      state.goal = next
      if (params.status === 'active' || fresh) state.ledger.halted = false
      this.clock(state)
      return next
    })
  }

  clear(threadId: string): boolean {
    return this.store.mutateGoalState(threadId, (state) => {
      const existed = state.goal !== null
      state.goal = null
      state.ledger = {
        ...emptyGoalLedger(),
        runningTurnId: state.ledger.runningTurnId,
        usage: state.ledger.usage,
      }
      return existed
    })
  }

  begin(threadId: string, turnId: string): void {
    this.store.mutateGoalState(threadId, (state) => {
      // 上次进程退出后的时间不计费；旧回合由恢复流程标为中断。
      state.ledger.runningTurnId = turnId
      state.ledger.activeSinceMs = null
      state.ledger.halted = false
      this.clock(state)
    })
  }

  resume(threadId: string): void {
    this.store.mutateGoalState(threadId, (state) => {
      const running = state.ledger.runningTurnId
      if (!running || this.store.turnStatus(running) !== 'inProgress') {
        state.ledger.runningTurnId = null
        state.ledger.activeSinceMs = null
      }
      state.ledger.halted = false
    })
  }

  usage(threadId: string, turnId: string, messageId: string, tokens: number): ThreadGoal | null {
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('原生 token 计数无效')
    return this.store.mutateGoalState(threadId, (state) => {
      const key = JSON.stringify([turnId, messageId])
      const prior = state.ledger.usage[key] ?? 0
      state.ledger.usage[key] = Math.max(prior, tokens)
      if (state.ledger.runningTurnId !== turnId || state.goal?.status !== 'active') return null
      this.settle(state)
      state.goal.tokensUsed += Math.max(0, tokens - prior)
      state.goal.updatedAt = nowSeconds()
      return state.goal
    })
  }

  finish(
    threadId: string,
    turnId: string,
    outcome: 'completed' | 'interrupted' | 'failed',
    usageLimited = false,
  ): ThreadGoal | null {
    return this.store.mutateGoalState(threadId, (state) => {
      if (state.ledger.runningTurnId !== turnId) return null
      this.settle(state)
      state.ledger.runningTurnId = null
      state.ledger.activeSinceMs = null
      if (outcome === 'interrupted') state.ledger.halted = true
      if (state.goal?.status === 'active') {
        if (outcome === 'failed') state.goal.status = usageLimited ? 'usageLimited' : 'blocked'
        // 预算在整个真实 SDK Turn 结束后检查，不打断已开始的工具。
        if (
          outcome === 'completed' &&
          state.goal.tokenBudget !== null &&
          state.goal.tokensUsed >= state.goal.tokenBudget
        )
          state.goal.status = 'budgetLimited'
        state.goal.updatedAt = nowSeconds()
      }
      return state.goal
    })
  }

  runnable(threadId: string): boolean {
    const state = this.store.goalState(threadId)
    return (
      state.goal?.status === 'active' &&
      !state.ledger.halted &&
      !state.ledger.runningTurnId &&
      !this.store.getThread(threadId)?.archived
    )
  }

  context(threadId: string): string | null {
    const goal = this.store.threadGoal(threadId)
    if (goal?.status !== 'active') return null
    return [
      '当前用户授权的持续目标：',
      goal.objective,
      '继续推进，直到完成或出现必须由用户解决的阻塞。完成后调用 update_goal complete。',
      '只有持续、无法自行解决的阻塞才调用 update_goal blocked；不要凭空宣称完成。',
      '用户暂停后不要继续目标；用户中断后等待恢复。遵守当前权限和计划确认流程。',
      goal.tokenBudget === null
        ? '本目标没有明确 token 预算。'
        : '目标 token 预算：' +
          goal.tokenBudget +
          '，已使用：' +
          goal.tokensUsed +
          '。预算将在当前回合结束后检查。',
    ].join('\n')
  }

  tool(
    threadId: string,
    turnId: string,
    name: string,
    args: Record<string, unknown>,
    callId: string,
  ): unknown {
    return this.store.mutateGoalState(threadId, (state) => {
      if (this.store.turnStatus(turnId) !== 'inProgress')
        throw new Error('目标工具所属回合已经结束')
      const prior = this.store.reserveTool(threadId, callId, submissionHash({ name, args }))
      if (prior) return prior.result
      if (name === 'create_goal') {
        if (state.goal && state.goal.status !== 'complete')
          throw new Error('已有未完成目标，不能替换')
        const goal = patchThreadGoal(threadId, null, {
          objective: args.objective,
          tokenBudget: args.token_budget,
          status: 'active',
        })
        const usage = state.ledger.usage
        state.goal = goal
        state.ledger = { ...emptyGoalLedger(), runningTurnId: turnId, usage }
        this.clock(state)
      } else if (name === 'update_goal') {
        if (!state.goal) throw new Error('当前没有目标')
        if (args.status !== 'complete' && args.status !== 'blocked')
          throw new Error('模型只能完成或阻塞目标')
        this.settle(state)
        state.goal.status = args.status
        state.goal.updatedAt = nowSeconds()
        this.clock(state)
      } else if (name !== 'get_goal') throw new ProtocolError(-32602, '未知目标工具')
      const goal = state.goal
      const result = {
        goal,
        remainingTokens:
          goal?.tokenBudget == null ? null : Math.max(0, goal.tokenBudget - goal.tokensUsed),
        completionBudgetReport: null,
      }
      // 目标状态与原生工具结果同一事务提交，崩溃后不会二次创建目标。
      this.store.completeTool(threadId, callId, result)
      return result
    })
  }
}
