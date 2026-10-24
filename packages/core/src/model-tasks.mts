// 定时任务在界面这一头的样子（设备的 deviceTasks 扩展投影过来的）。
// 任务存在设备上、由设备服务按时执行；核心只是转运和跟着通知改，界面和移动端只认这里的类型。
// 和协议的差别：时间一律是毫秒时间戳（和侧栏的 updatedAt 一样），每条带着它在哪台设备上。
// 日程、目标的形状和协议一模一样，直接沿用（界面要拿它们去做表单、预览下一次）。
import type {
  TaskOrigin,
  TaskRunApprovalKind,
  TaskRunApprovalState,
  TaskRunErrorCode,
  TaskRunStatus,
  TaskSchedule,
  TaskScheduleType,
  TaskSessionSettings,
  TaskStatus,
  TaskTarget,
  TaskTargetKind,
  TaskTimeOfDay,
  TaskWeekday,
} from '../../protocol/src/device-tasks.mjs'

export type {
  TaskOrigin,
  TaskRunApprovalKind,
  TaskRunApprovalState,
  TaskRunErrorCode,
  TaskRunStatus,
  TaskSchedule,
  TaskScheduleType,
  TaskSessionSettings,
  TaskStatus,
  TaskTarget,
  TaskTargetKind,
  TaskTimeOfDay,
  TaskWeekday,
}

export interface TaskErrorView {
  /** 原因的种类，界面按它说一句人话；message 是设备给的原话 */
  code: TaskRunErrorCode
  message: string
}

export interface TaskRunView {
  id: string
  taskId: string
  deviceId: string
  /** scheduled：按日程；manual：立即运行 */
  trigger: 'scheduled' | 'manual'
  /** 按日程是哪个时间点的；手动的是点下去的时间。毫秒 */
  scheduledFor: number
  /** 合并进这一次的、之前错过的时间点有几个。0 是没有 */
  coalesced: number
  status: TaskRunStatus
  harness: string
  /** 跑在哪个会话里；还没建出来是 null */
  threadId: string | null
  startedAt: number | null
  finishedAt: number | null
  /** 回合最后一条回答的开头 */
  summary: string | null
  error: TaskErrorView | null
  /** 看过了没有。没结束的总是 true */
  read: boolean
  /** 回合里要人答的请求（审批、提问），按收到的先后；没有是空数组 */
  approvals: TaskRunApprovalView[]
}

/** 任务回合里一条要人答的请求。等着的时候打开那个会话就能答，到 declineAt 没人答设备替人拒绝 */
export interface TaskRunApprovalView {
  requestId: string
  kind: TaskRunApprovalKind
  /** 一句话：命令原文、改文件的理由、要的权限、第一道题…… */
  title: string
  /** 毫秒 */
  requestedAt: number
  declineAt: number
  state: TaskRunApprovalState
  settledAt: number | null
}

export interface TaskView {
  id: string
  deviceId: string
  name: string
  prompt: string
  schedule: TaskSchedule
  /** IANA 时区名 */
  timezone: string
  status: TaskStatus
  target: TaskTarget
  origin: TaskOrigin
  /** 每改一次加 1；改的时候核心自己带上 */
  revision: number
  createdAt: number
  updatedAt: number
  /** 下一次按日程跑的时间；暂停了、跑完了是 null */
  nextRunAt: number | null
  lastRunAt: number | null
  lastRun: TaskRunView | null
  lastError: TaskErrorView | null
  /** 还没看过的已结束的运行有几条 */
  unreadRuns: number
}

/**
 * 一台设备上的定时任务（tasks 主题的快照）。
 * available：这台设备的服务支持不支持定时任务（设备信息里列没列 deviceTasks）。
 * null 是还不知道（还没连上过）；false 时界面说“这台设备的服务版本不支持定时任务”。
 * 断开之后留着断开之前知道的那一份，连回来对过账再换掉
 */
export interface TasksView {
  deviceId: string
  available: boolean | null
  /** 按建的先后 */
  tasks: TaskView[]
}

/**
 * 新建一个任务要给的。timezone 给 null 是用设备所在的时区；status 不给是 active。
 * target 的形状同协议：newThread 要 harness、cwd（设备上的绝对路径）、workspaceId、settings；
 * thread 要 harness、threadId
 */
export interface TaskDraft {
  name: string
  prompt: string
  schedule: TaskSchedule
  timezone: string | null
  target: TaskTarget
  status?: 'active' | 'paused'
}

/** 改一个任务：只改给了的那几项。target 只能改 newThread 的 cwd、workspaceId、settings */
export interface TaskPatch {
  name?: string
  prompt?: string
  schedule?: TaskSchedule
  timezone?: string
  status?: TaskStatus
  target?: {
    cwd?: string
    workspaceId?: string | null
    settings?: TaskSessionSettings
  }
}

/**
 * 一个会话和定时任务的关系（侧栏摘要上的那一项）。
 * run：这个会话是某个任务的一次运行跑出来的（或者那次运行在这个会话里接着发的）；
 * target：这个会话是某个任务的目标（“在已有会话里接着发”的那种），之后每次运行都在这里。
 * 两样都沾的算 target。和定时任务无关的会话是 null
 */
export type SessionTaskMark =
  | {
      kind: 'run'
      taskId: string
      runId: string
      trigger: 'scheduled' | 'manual'
      /** 毫秒 */
      scheduledFor: number
    }
  | { kind: 'target'; taskId: string }
