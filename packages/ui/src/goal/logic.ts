// 持续目标在界面上的几条规矩：输入框里的 /goal 怎么认、暂停与继续的按钮出不出、用量怎么写。
// 纯逻辑：test/goal-logic.test.mjs 直接引这个文件，所以只用可擦除的语法、不引样式和组件。
import type { GoalStatus } from '@litch/core'

/**
 * 输入框里发出去的字是不是在设目标：`/goal` 打头，后面跟着要做到的事（可以换行写长）。
 * 是的话给出目标的话（去掉前后空白，可能是空的：只打了 /goal）；不是给 null。
 * `/goals`、`/goalx` 这种不算：那是别的命令或技能
 */
export function parseGoalCommand(text: string): { objective: string } | null {
  const match = /^\s*\/goal(?=$|\s)/.exec(text)
  if (!match) return null
  return { objective: text.slice(match[0].length).trim() }
}

/** 选了单子上的 /goal：输入框里留下这一截，光标在后面，接着写目标 */
export const GOAL_PREFIX = '/goal '

/**
 * 暂停与继续那个按钮按下去会改成什么。在做的能暂停；暂停了、受阻、用量到顶的能继续；
 * 预算用完、做完了的没有这个按钮（继续也只会马上又停下，要换新目标或者清掉）
 */
export function toggleTarget(status: GoalStatus): 'active' | 'paused' | null {
  if (status === 'active') return 'paused'
  if (status === 'paused' || status === 'blocked' || status === 'usageLimited') return 'active'
  return null
}

/**
 * 已经有目标时再设一个，要不要先问一句“换掉吗”：现有的还没做完、新写的和它不一样才问。
 * 做完了的直接换：那就是开始下一个
 */
export function asksBeforeReplace(
  current: { objective: string; status: GoalStatus } | null | undefined,
  objective: string,
): boolean {
  if (!current || current.status === 'complete') return false
  return current.objective.trim() !== objective.trim()
}

/** 词元数的短写法：950、12.3K、4.5M。中英文一样写 */
export function compactTokens(count: number): string {
  if (count < 1000) return String(Math.round(count))
  if (count < 1_000_000) return `${trim(count / 1000)}K`
  return `${trim(count / 1_000_000)}M`
}

const trim = (value: number): string =>
  (value >= 100 ? value.toFixed(0) : value.toFixed(1)).replace(/\.0$/, '')

/**
 * 输入框上方那一行的用量写什么：设了预算、还在做或刚好用完预算的，写“用了多少 / 预算”；
 * 别的写用了多久（在做的，从上次更新起的时间也算进去，界面每秒走一下）
 */
export function usageKind(goal: {
  status: GoalStatus
  tokenBudget: number | null
}): 'tokens' | 'time' {
  return goal.tokenBudget !== null && (goal.status === 'active' || goal.status === 'budgetLimited')
    ? 'tokens'
    : 'time'
}

/** 目标到现在一共花了多少毫秒：在做的加上从上次更新到现在 */
export function goalElapsedMs(
  goal: { status: GoalStatus; timeUsedSeconds: number; updatedAt: number },
  now: number,
): number {
  const base = goal.timeUsedSeconds * 1000
  return goal.status === 'active' ? base + Math.max(0, now - goal.updatedAt) : base
}

/** 目标用了多久，最粗到天：40 秒、12 分、3 时 05 分、2 天 4 时。say 是界面的翻译函数 */
export function goalTime(
  ms: number,
  say: (
    key: 'goal.time.s' | 'goal.time.m' | 'goal.time.h' | 'goal.time.d',
    vars: Record<string, string | number>,
  ) => string,
): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  if (seconds < 60) return say('goal.time.s', { n: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return say('goal.time.m', { m: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return say('goal.time.h', { h: hours, m: String(minutes % 60).padStart(2, '0') })
  return say('goal.time.d', { d: Math.floor(hours / 24), h: hours % 24 })
}
