// 后台任务（扩展名 backgroundTasks）：回合结束之后还在跑的工作——后台命令、Monitor、后台子代理、Workflow。
// 回合状态只描述前台工作，不改；“空闲但还有后台任务”用会话上一份独立的集合表达，变了就整份重发（电平信号，
// 断线重连、引擎重启都对得上）。原生表示照旧：Claude、原生 codex 在已结束的回合里留着 inProgress 的命令条目，
// 结束时补 item/completed，没改过的官方桌面端照常能用。新增的东西只发给声明了这个扩展的连接。
// 定义的原文在仓库根目录 protocol/extensions/background-tasks.json。
//
// 这个文件不引用别的文件：各个入口、设备进程和客户端核心都直接引用它。

/** 任务的种类 */
export type BackgroundTaskKind = 'shell' | 'agent' | 'monitor' | 'workflow' | 'remote' | 'other'

/** 任务的状态。结束过的只在引擎（设备进程）的内存里，重启就没了 */
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped'

export interface LitchBackgroundTask {
  /** 引擎内唯一，同一个任务前后不变 */
  id: string
  kind: BackgroundTaskKind
  /** 一行：命令或描述，客户端自己截断 */
  title: string
  status: BackgroundTaskStatus
  /** 发起它的条目（一般是那条命令），能挂回对话 */
  itemId?: string
  turnId?: string
  /** 后台子代理（kind 为 agent）在这个会话里对应的子线程：客户端点这一行进它的子代理页。没有子线程的不带 */
  agentThreadId?: string
  /** 毫秒。界面的“用时”=（endedAt ?? 现在）− startedAt */
  startedAt?: number
  endedAt?: number
}

/**
 * 会话对象上的 `litchBackground`（thread/read、thread/list、thread/resume、thread/started 的会话对象），
 * 也是变化通知的主体。只在有任务（运行中的或这次运行里结束过的）时带
 */
export interface LitchBackground {
  /** 运行中的在前（按开始时间），结束过的在后（按结束时间倒序，最多 BACKGROUND_ENDED_LIMIT 个） */
  tasks: LitchBackgroundTask[]
  /** 后台任务结束后这个 harness 会不会自己接着做（Claude、dsh 会，原生 codex 不会） */
  wakesOnFinish: boolean
}

/** 集合变了：整份重发。发给所有声明过扩展的连接，不只是订阅者（侧栏要标没打开过的会话） */
export interface BackgroundChangedNotification extends LitchBackground {
  threadId: string
}

/**
 * 回合上的 `litchOrigin`：这一回合是谁开的。没有这个字段的按用户发起的算。
 * peer 是别的会话发来消息、引擎空闲时自己开的那一轮（消息本身是回合开头带 litchPeer 的用户消息条目，peerMessages 扩展）
 */
export type LitchTurnOrigin = 'user' | 'backgroundTask' | 'schedule' | 'goal' | 'queue' | 'peer'

export const BACKGROUND_TASKS_NOTIFICATION = {
  changed: 'litch/thread/background/changed',
} as const

/** 每个会话最多留多少个结束过的任务 */
export const BACKGROUND_ENDED_LIMIT = 50

/** 运行中的在前（按开始时间），结束过的在后（按结束时间倒序），结束过的最多留 BACKGROUND_ENDED_LIMIT 个 */
export function orderBackgroundTasks(tasks: Iterable<LitchBackgroundTask>): LitchBackgroundTask[] {
  const running: LitchBackgroundTask[] = []
  const ended: LitchBackgroundTask[] = []
  for (const task of tasks) (task.status === 'running' ? running : ended).push(task)
  running.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  ended.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  return [...running, ...ended.slice(0, BACKGROUND_ENDED_LIMIT)]
}

/** 还在跑的有几个 */
export function runningBackgroundTasks(tasks: readonly LitchBackgroundTask[]): number {
  let count = 0
  for (const task of tasks) if (task.status === 'running') count++
  return count
}
