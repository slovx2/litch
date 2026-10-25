// 待办在手机上的纯逻辑：会话里最近的一份待办是哪份、输入框上方那个小按钮出不出、写什么。
// 照桌面端右侧信息栏的待办卡片（packages/ui/src/rail/InfoRail.tsx）：取各回合里最后一份有步骤的，
// 回合结束了也留着，直到下一份换掉它。手机上没有那一栏，收成输入框上方的一个小按钮，点开是浮窗。
// 不依赖 React，单元测试直接跑。
import { type SessionView, type TodoItem, type TodoStep, todoKey } from '@litch/core'

export interface LatestTodo {
  /** 它在哪个回合 */
  turnId: string
  item: TodoItem
  /** 它所在的回合还在跑 */
  running: boolean
}

/** 会话里最近的一份待办：从最后一个回合往前找第一份有步骤的。没有是 null */
export function latestTodo(view: Pick<SessionView, 'turns' | 'items'>): LatestTodo | null {
  for (const turn of view.turns.toReversed()) {
    const item = view.items[todoKey(turn.id)]
    if (item?.kind === 'todo' && item.steps.length > 0)
      return { turnId: turn.id, item, running: turn.status === 'running' }
  }
  return null
}

/** 做完了几步、一共几步 */
export function todoProgress(steps: readonly TodoStep[]): { done: number; total: number } {
  return {
    done: steps.filter((step) => step.status === 'completed').length,
    total: steps.length,
  }
}

/**
 * 输入框上方的小按钮出不出：有没做完的就一直在（回合结束了也在，下一回合接着做）；
 * 全做完了只在它所在的回合还在跑时留着，回合结束就收掉（对话里那一行还在）
 */
export function todoChipShown(todo: LatestTodo | null): boolean {
  if (!todo) return false
  const { done, total } = todoProgress(todo.item.steps)
  return done < total || todo.running
}

/** 回合结束时还标着“正在做”的，算没做完（和对话里一样） */
export function stepStatus(step: TodoStep, running: boolean): TodoStep['status'] {
  return step.status === 'inProgress' && !running ? 'pending' : step.status
}

/** 对话里那一行写哪一步：正在做的那一步，没有就是第一个没做的；全做完了是 null */
export function currentStep(steps: readonly TodoStep[], running: boolean): TodoStep | null {
  return (
    steps.find((step) => stepStatus(step, running) === 'inProgress') ??
    steps.find((step) => step.status !== 'completed') ??
    null
  )
}
