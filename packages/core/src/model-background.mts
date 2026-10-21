// 后台任务在界面这一头的样子：回合结束以后还在跑的工作（后台命令、Monitor、工作流）。
// 报集合的连接（backgroundTasks 扩展，harness 声明了 features.backgroundTasks）照对面的集合投影；
// 不报的退回从已结束回合里还 inProgress 的命令条目派生（projection/background.mts）。
// 回合的状态只描述前台工作：后台任务在跑时会话照样是 idle。
import type {
  BackgroundTaskKind,
  BackgroundTaskStatus,
  LitchTurnOrigin,
} from '../../protocol/src/background-tasks.mjs'

export type { BackgroundTaskKind, BackgroundTaskStatus }

/** 回合是怎么开始的。user 是用户发的；backgroundTask 是后台任务结束后 harness 自己接着做的；schedule 是定时任务触发的 */
export type TurnOrigin = LitchTurnOrigin

export interface BackgroundTaskView {
  /** 引擎内唯一，前后不变 */
  id: string
  kind: BackgroundTaskKind
  /** 一行：命令或描述 */
  title: string
  status: BackgroundTaskStatus
  /** 发起它的条目（协议里的条目标识）。不知道是 null */
  itemId: string | null
  /** 发起它的回合（协议里的回合标识）。不知道是 null */
  turnId: string | null
  /** 毫秒时间戳。不知道是 null */
  startedAt: number | null
  endedAt: number | null
}

export interface SessionBackgroundView {
  /** 运行中的在前（先开始的在前），已结束的在后（后结束的在前） */
  tasks: BackgroundTaskView[]
  /** 还在跑的有几个 */
  running: number
  /** 跑完以后 harness 会不会自己接着做。派生出来的不知道，是 null */
  wakesOnFinish: boolean | null
}
