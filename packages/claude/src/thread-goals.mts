import { ProtocolError } from './protocol-contract.mjs'
import { nowSeconds } from './util.mjs'

const goalStatuses = [
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
] as const
export type GoalStatus = (typeof goalStatuses)[number]
export interface ThreadGoal {
  threadId: string
  objective: string
  status: GoalStatus
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
}

// 0.157.1 的 goal/set 是部分更新：省略预算保持原值，显式 null 清除预算。
export function patchThreadGoal(
  threadId: string,
  previous: ThreadGoal | null,
  params: Record<string, unknown>,
): ThreadGoal {
  let objective = previous?.objective
  if (params.objective != null) {
    if (typeof params.objective !== 'string' || !params.objective.trim())
      throw new ProtocolError(-32602, 'objective 必须是非空字符串')
    objective = params.objective.trim()
  }
  if (!objective) throw new ProtocolError(-32602, '没有现有目标，必须提供 objective')
  let status = previous?.status ?? 'active'
  if (params.status != null) {
    if (typeof params.status !== 'string' || !goalStatuses.includes(params.status as GoalStatus))
      throw new ProtocolError(-32602, '目标状态无效')
    status = params.status as GoalStatus
  }
  let tokenBudget = previous?.tokenBudget ?? null
  if (params.tokenBudget !== undefined) {
    if (
      params.tokenBudget !== null &&
      (typeof params.tokenBudget !== 'number' ||
        !Number.isSafeInteger(params.tokenBudget) ||
        params.tokenBudget <= 0)
    )
      throw new ProtocolError(-32602, 'tokenBudget 必须是正整数或 null')
    tokenBudget = params.tokenBudget as number | null
  }
  const now = nowSeconds()
  return {
    threadId,
    objective,
    status,
    tokenBudget,
    tokensUsed: previous?.tokensUsed ?? 0,
    timeUsedSeconds: previous?.timeUsedSeconds ?? 0,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
}
