// “计划写好了，要不要执行”这一问什么时候出（和桌面端 packages/ui/src/composer/plan-ask.ts 同一套判断）。
// 适配器的引擎出完计划自己会来问（手机的核心也声明了 planConfirmation），走的是提问卡片；
// 原生 codex 出完计划回合就结束了，由客户端来问。这里只管判断，画在 PlanAsk.tsx。

/** 引擎自己问“要不要执行计划”时那道题的标识（适配器的 Claude 引擎定的） */
const PLAN_QUESTION_ID = 'execute_plan'

/** 眼前这个提问是不是引擎在问“计划写好了，接下来怎么办”：带着约定的标识，或者出在已经出了计划的回合里 */
export const asksAboutPlan = (questionIds: readonly string[], turnHasPlan: boolean): boolean =>
  turnHasPlan || questionIds.includes(PLAN_QUESTION_ID)

/**
 * 现在该问的是哪一份计划（条目的标识）；不该问是 null。会话在计划模式里、能发消息，最后一个回合正常结束了、
 * 里面出过计划，引擎自己没在这个回合里问过，人也还没对这一份表过态
 */
export function planToConfirm(facts: {
  mode: string | null | undefined
  live: boolean
  turn: { id: string; status: string; planId: string | null } | null
  askedIn: string | undefined
  settled: string | undefined
}): string | null {
  const { turn } = facts
  if (facts.mode !== 'plan' || !facts.live || !turn || turn.status !== 'completed') return null
  if (facts.askedIn === turn.id || !turn.planId || turn.planId === facts.settled) return null
  return turn.planId
}

/** 会话 → 引擎在哪个回合里自己问过 */
const asked = new Map<string, string>()
/** 会话 → 人对哪一份计划表过态了（点了“先不执行”） */
const settled = new Map<string, string>()

export const markPlanAsked = (session: string, turnId: string): void => {
  asked.set(session, turnId)
}
export const planAskedIn = (session: string): string | undefined => asked.get(session)
export const settlePlan = (session: string, planId: string): void => {
  settled.set(session, planId)
}
export const settledPlan = (session: string): string | undefined => settled.get(session)
