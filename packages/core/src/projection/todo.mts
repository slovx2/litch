// 待办进度的投影：协议里的“回合计划更新”通知 → 对话里的一个待办条目。纯函数。
// 协议不把它当条目，重新载入会话时历史里没有它，所以核心自己记着（见 device/live.mts），
// 载入之后按原来的位置放回去。
import type { TurnPlanUpdatedNotification } from '../../../protocol/src/index.mjs'
import type { SessionView, TodoItem, TodoStep } from '../model.mjs'

/** 记下来的一份待办：内容，加上它在回合里排在第几个条目的位置 */
export interface KeptTodo {
  at: number
  note: string | null
  steps: TodoStep[]
}

/** 待办条目在界面里的标识。一个回合只有一个；带 # 是为了不和对面给的条目标识撞上 */
export const todoKey = (viewTurnId: string): string => `${viewTurnId}:#todo`

const STATUSES: readonly string[] = ['pending', 'inProgress', 'completed']

/** 对面的协议可能比我们的类型新：不认识的状态按“还没做”算，缺的字段给空的 */
export function projectTodo(
  params: Pick<TurnPlanUpdatedNotification, 'explanation' | 'plan'>,
): Pick<TodoItem, 'note' | 'steps'> {
  const steps = (Array.isArray(params.plan) ? params.plan : []).map(
    (entry): TodoStep => ({
      text: typeof entry?.step === 'string' ? entry.step : '',
      status: STATUSES.includes(entry?.status) ? entry.status : 'pending',
    }),
  )
  const note = typeof params.explanation === 'string' ? params.explanation.trim() : ''
  return { note: note || null, steps }
}

/** 回合结束了：还标着“正在做”的步骤其实没做完，改回“还没做”。没有要改的就返回原来那份 */
export function settleSteps(steps: TodoStep[]): TodoStep[] {
  if (!steps.some((step) => step.status === 'inProgress')) return steps
  return steps.map((step) => (step.status === 'inProgress' ? { ...step, status: 'pending' } : step))
}

/**
 * 把记着的待办放回刚载入的会话里。原地修改。
 * kept 按协议里的回合标识记；回合已经不在了（被回退掉）的那几份不放。
 */
export function placeTodos(view: SessionView, kept: ReadonlyMap<string, KeptTodo>): void {
  for (const [turnId, todo] of kept) {
    const turn = view.turns.find((entry) => entry.id === turnId)
    if (!turn) continue
    const id = todoKey(turn.id)
    if (turn.itemIds.includes(id)) continue
    const steps = turn.status === 'running' ? todo.steps : settleSteps(todo.steps)
    view.items[id] = { id, kind: 'todo', note: todo.note, steps }
    turn.itemIds.splice(Math.min(Math.max(todo.at, 0), turn.itemIds.length), 0, id)
  }
}
