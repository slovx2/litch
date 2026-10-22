// 持续目标在界面这一头的样子（协议原有的 thread/goal/*，harness 声明了 features.goals 才有）。
// 目标设下以后一直有效：回合结束、会话空闲时 harness 自己接着做下一轮，直到模型报完成、受阻，
// 或者用户暂停、清掉，或者用量到了预算。一个会话同一时间最多一个目标。
import type { ThreadGoalStatus } from '../../protocol/src/index.mjs'

/**
 * 目标的状态，照协议原样：
 * active 在做（空闲时会自动续跑）；paused 用户暂停了；blocked 模型报受阻、或者回合出错停下了；
 * usageLimited 账号的用量到顶了；budgetLimited 用到了这个目标的预算；complete 模型报做完了
 */
export type GoalStatus = ThreadGoalStatus

export interface SessionGoalView {
  objective: string
  status: GoalStatus
  /** 词元预算。没设是 null */
  tokenBudget: number | null
  tokensUsed: number
  /** 在 active 状态下花掉的时间，秒 */
  timeUsedSeconds: number
  /** 毫秒时间戳 */
  createdAt: number
  updatedAt: number
}

/**
 * 界面要改目标时给的那几项，照 thread/goal/set 的部分更新：没给的不变。
 * 没有目标时 objective 必须给（新设一个，从 active 开始）。tokenBudget 给 null 是去掉预算
 */
export interface GoalChange {
  objective?: string
  status?: 'active' | 'paused'
  tokenBudget?: number | null
}

/**
 * 刚达成的目标留下的那一句（照官方桌面端）：目标一报达成，客户端就清掉它（thread/goal/clear），
 * 输入框上方那一行随之没了，改在达成它的那个回合最后一条回答下面写“目标已达成 · 用时 N”。
 * 只记最近一次；再设新目标就没了。只在这边的内存里，重新打开会话不再有
 */
export interface GoalReachedView {
  /** 达成它的那个回合（界面里的标识） */
  turnId: string
  objective: string
  /** 目标在做的状态下一共花的时间，秒（协议的 timeUsedSeconds） */
  timeUsedSeconds: number
}
