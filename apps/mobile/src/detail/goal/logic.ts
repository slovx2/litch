// 手机上输入框里的 /goal 怎么处理、斜杠单子出不出：判断都用桌面的 goal/logic.ts，这里只把它们拼成手机要的几步。
// 纯逻辑：test/goal.test.mjs 直接引这个文件
import type { SessionGoalView } from '@litch/core'
import {
  asksBeforeReplace,
  GOAL_PREFIX,
  parseGoalCommand,
} from '../../../../../packages/ui/src/goal/logic.ts'

/**
 * 发出去的这一句怎么办：harness 不会目标、不是 /goal 打头的照常当消息发（send）；
 * /goal 后面没写字、带着图片或评论的不收（refuse，给出要说的那句的键）；
 * 要换掉一个还没做完的目标的先问（ask）；别的直接设成目标（goal）
 */
export type GoalIntent =
  | { kind: 'send' }
  | { kind: 'refuse'; key: 'goal.needText' | 'goal.textOnly' }
  | { kind: 'ask' | 'goal'; objective: string }

export function goalIntent(
  text: string,
  attachments: number,
  able: boolean,
  current: SessionGoalView | null,
): GoalIntent {
  const parsed = able ? parseGoalCommand(text) : null
  if (!parsed) return { kind: 'send' }
  if (!parsed.objective) return { kind: 'refuse', key: 'goal.needText' }
  if (attachments > 0) return { kind: 'refuse', key: 'goal.textOnly' }
  return {
    kind: asksBeforeReplace(current, parsed.objective) ? 'ask' : 'goal',
    objective: parsed.objective,
  }
}

/**
 * 斜杠单子上出不出 /goal：harness 会目标、输入框里只打了一个斜杠开头的词（还没空格），而且是 /goal 的开头。
 * 已经写成 `/goal ` 的不再出
 */
export function slashGoalShown(text: string, able: boolean): boolean {
  if (!able || !/^\/[a-z]*$/i.test(text)) return false
  return GOAL_PREFIX.trimEnd().startsWith(text.toLowerCase())
}

export { GOAL_PREFIX }
