// “计划写好了，要不要执行”这一问什么时候出。
// 适配器的引擎出完计划自己会来问，走的是提问卡片（Claude Code 是引擎出的一道题，Pi 是计划插件的那张菜单）；
// 原生 codex 出完计划回合就结束了，由客户端来问——官方的终端界面也是这样做的。
// 这里只管判断，怎么画在 PlanAsk.tsx。
// 纯逻辑加两张只在这次运行里有效的小表：test/plan-ask.test.mjs 直接引这个文件，所以只用可擦除的语法。
import type { ItemView } from '@litch/core'
import { isUserReply } from '../../../protocol/src/user-reply.mts'

/** 引擎自己问“要不要执行计划”时那道题的标识（适配器的 Claude 引擎定的） */
export const PLAN_QUESTION_ID = 'execute_plan'

/**
 * 眼前这个提问是不是引擎在问“计划写好了，接下来怎么办”：
 * 题目带着约定的标识，或者它出在一个已经出了计划的回合里（Pi 的插件那张菜单没有固定的标识）。
 */
export const asksAboutPlan = (questionIds: readonly string[], turnHasPlan: boolean): boolean =>
  turnHasPlan || questionIds.includes(PLAN_QUESTION_ID)

/** 定“现在出不出这一问”要看的东西 */
export interface PlanFacts {
  /** 会话现在的协作模式 */
  mode: string | null | undefined
  /** 能不能在这个会话里发消息 */
  live: boolean
  /** 最近一次交出计划的回合：不被后来的无关回合替换。 */
  turn: { id: string; status: string; itemIds: readonly string[] } | undefined
  /** 一个条目是什么种类 */
  kindOf(itemId: string): string | undefined
  /** 这个回合里引擎自己问过了 */
  asked: boolean
  /** 人已经对哪一份计划表过态了（点了“先不执行”） */
  settled: string | undefined
}

/**
 * 现在该问的是哪一份计划（条目的标识）；不该问就是 null。
 * 要问的情形：会话在计划模式里，交出计划的回合正常结束了，引擎自己没问过，人也还没表过态。
 */
export function planToConfirm(facts: PlanFacts): string | null {
  const { turn } = facts
  if (facts.mode !== 'plan' || !facts.live || !turn || turn.status !== 'completed') return null
  if (facts.asked) return null
  const planId = turn.itemIds.findLast((id) => facts.kindOf(id) === 'plan')
  if (!planId || planId === facts.settled) return null
  return planId
}

/** 无关的回报与后台回合不替换计划；计划的新稿仍取最新一份。两端共用。 */
export function latestPlanTurn<
  T extends { status: string; itemIds: readonly string[]; origin?: string },
>(turns: readonly T[], itemOf: (id: string) => ItemView | undefined): T | undefined {
  const at = turns.findLastIndex(
    (turn) => turn.status === 'completed' && turn.itemIds.some((id) => itemOf(id)?.kind === 'plan'),
  )
  const plan = turns[at]
  if (!plan) return undefined
  const planAt = plan.itemIds.findLastIndex((id) => itemOf(id)?.kind === 'plan')
  for (let t = at; t < turns.length; t++) {
    const turn = turns[t]
    if (!turn) continue
    for (let i = t === at ? planAt + 1 : 0; i < turn.itemIds.length; i++) {
      const item = itemOf(turn.itemIds[i] ?? '')
      if (isUserReply(item, turn.origin, i)) return undefined
    }
  }
  return plan
}

/** 会话 → 引擎在哪个回合里自己问过 */
const asked = new Map<string, string>()
/** 会话 → 人对哪一份计划表过态了 */
const settled = new Map<string, string>()

export const markPlanAsked = (session: string, turnId: string): void => {
  asked.set(session, turnId)
}
export const planAskedIn = (session: string): string | undefined => asked.get(session)
export const settlePlan = (session: string, planId: string): void => {
  settled.set(session, planId)
}
export const settledPlan = (session: string): string | undefined => settled.get(session)
