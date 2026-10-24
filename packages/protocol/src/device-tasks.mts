// 定时任务（扩展名 deviceTasks）：任务存在设备上、由设备服务按时执行，客户端断开也照样跑。
// 这里的东西都不是 codex 原有的。定义的原文在仓库根目录 protocol/extensions/device-tasks.json。
// 规矩：扩展只增不改，扩展内容只发给声明过的连接，没改过的官方桌面端要始终能连。
//
// 这个文件不引用别的文件：设备进程（packages/device）和客户端核心（packages/core）都直接引用它。
// 时间一律是 Unix 秒。日程怎么算下一次在 task-schedule.mts。

/** 星期，写法同 RFC 5545 */
export type TaskWeekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'

/** 时刻，24 小时制的 `HH:MM`，按任务的时区算 */
export type TaskTimeOfDay = string

/**
 * 日程。墙钟时间都按任务的 `timezone` 算：夏令时切换的那天，跳过的时刻顺延到切换后的同一墙钟时刻，
 * 重复的时刻只算第一次。相邻两次至少隔 MIN_TASK_INTERVAL_MINUTES 分钟（task-schedule.mts）。
 */
export type TaskSchedule =
  /** 只跑一次。`at` 是任务时区里的墙钟时间 `YYYY-MM-DDTHH:MM`；跑过（或者错过后补跑过）就变成 completed */
  | { type: 'once'; at: string }
  /** 每隔几分钟，从任务建好（或者这条日程改好）的那一刻算起 */
  | { type: 'interval'; minutes: number }
  /** 每隔几小时，在第几分钟；days 不是 null 时只在这几天跑。从当天 0 点起按间隔数 */
  | { type: 'hourly'; intervalHours: number; minute: number; days: TaskWeekday[] | null }
  | { type: 'daily'; time: TaskTimeOfDay }
  /** 周一到周五 */
  | { type: 'weekdays'; time: TaskTimeOfDay }
  | { type: 'weekly'; days: TaskWeekday[]; time: TaskTimeOfDay }
  /** 每月第几天；这个月没有这一天（比如 31 号）就在这个月最后一天跑 */
  | { type: 'monthly'; day: number; time: TaskTimeOfDay }

export type TaskScheduleType = TaskSchedule['type']

/** 新会话用的设置。null 是用那个 harness 的默认。含义和客户端新建会话时选的一样 */
export interface TaskSessionSettings {
  model: string | null
  /** 推理强度 */
  effort: string | null
  /** 权限预设的 id（harness 在 runtime/info 里声明的 permissionPresets）；没声明预设的 harness 上是协议的审批策略名 */
  permission: string | null
}

/**
 * 到点之后做什么。
 * newThread：每次新建一个会话，在里面发提示词。
 * thread：在一个已有的会话里接着发（会话正在跑回合时等它空下来）。
 * 任务建好之后 kind 不能改，harness、threadId 也不能改；newThread 的 cwd、workspaceId、settings、worktree 能改。
 */
export type TaskTarget =
  | {
      kind: 'newThread'
      harness: string
      /** 设备上的绝对路径 */
      cwd: string
      /** 新会话归到哪个工作区（deviceWorkspaces 扩展里的项目 id）；不归是 null */
      workspaceId: string | null
      settings: TaskSessionSettings
      /**
       * 每次在新工作树里跑（worktrees 扩展）：设备层从 cwd 所在仓库的默认分支切一个新工作树，新会话开在里面，
       * 会话是工作树的主人。只有设备列了 worktrees、cwd 在 git 仓库里才能设；不在的不带（等于 false）
       */
      worktree?: boolean
    }
  | { kind: 'thread'; harness: string; threadId: string }

export type TaskTargetKind = TaskTarget['kind']

/** active：按日程跑；paused：不跑，但还能立即运行；completed：一次性任务跑完了，不再按日程跑 */
export type TaskStatus = 'active' | 'paused' | 'completed'

/** 任务是怎么来的 */
export type TaskOrigin =
  /** 客户端界面上建的 */
  | { kind: 'client' }
  /** 模型在会话里用 litch_tasks 工具建的；threadId 是那个会话 */
  | { kind: 'tool'; harness: string; threadId: string }

export interface TaskError {
  /** 原因，见 TASK_RUN_ERROR */
  code: TaskRunErrorCode
  message: string
}

export interface DeviceTask {
  /** 设备范围内唯一 */
  id: string
  /** 1–120 个字 */
  name: string
  /** 1–100000 个字 */
  prompt: string
  schedule: TaskSchedule
  /** IANA 时区名，例如 Asia/Shanghai */
  timezone: string
  status: TaskStatus
  target: TaskTarget
  origin: TaskOrigin
  /** 每改一次加 1。update 要带上，对不上回 taskConflict */
  revision: number
  createdAt: number
  updatedAt: number
  /** 下一次按日程跑的时间；paused、completed 时是 null */
  nextRunAt: number | null
  /** 最近一次运行开始的时间；没跑过是 null */
  lastRunAt: number | null
  /** 最近一次运行；没跑过是 null */
  lastRun: DeviceTaskRun | null
  /** 最近一次失败的原因；之后成功一次就清掉 */
  lastError: TaskError | null
  /** 还没看过的已结束的运行有几条 */
  unreadRuns: number
}

/** queued：轮到它但还没开始（并发到了上限、会话正忙）；running：回合在跑；其余是结束了 */
export type TaskRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

export interface DeviceTaskRun {
  /** 设备范围内唯一 */
  id: string
  taskId: string
  /** scheduled：按日程；manual：立即运行（界面上点的，或者模型调工具） */
  trigger: 'scheduled' | 'manual'
  /** 按日程是哪个时间点的；手动的是点下去的时间 */
  scheduledFor: number
  /** 这次之前错过、合并进这一次的时间点有几个（设备关机、睡眠、上一次还没跑完）。0 是没有 */
  coalesced: number
  status: TaskRunStatus
  harness: string
  /** 回合在哪个会话里；还没建出来是 null */
  threadId: string | null
  turnId: string | null
  startedAt: number | null
  finishedAt: number | null
  /** 回合最后一条回答的开头（最多 TASK_RUN_SUMMARY_MAX 个字）；没有是 null */
  summary: string | null
  error: TaskError | null
  /** 用户看过没有。没结束的总是 true */
  read: boolean
  /**
   * 回合结束时会话里还有几个后台任务在跑（backgroundTasks 扩展）：运行照常算结束，这里注明。
   * 之后续跑的回合结束、后台全部结束时设备进程会更新它（和 summary），没有的不带
   */
  backgroundTasks?: number
  /**
   * 回合里引擎发来、要人答的请求（审批、提问、MCP 征询），按收到的先后。等着的时候连着的客户端打开会话就能答；
   * 到 declineAt 还没人答，设备服务替人拒绝（设备设置 tasks.approvalTimeoutMinutes，默认 30 分钟）。
   * 没有的不带。不含登录审批（litch_browser 的 request_sign_in，那是客户端工具调用，不经这里）
   */
  approvals?: TaskRunApproval[]
}

/** 回合里要人答的请求是哪一种 */
export type TaskRunApprovalKind =
  | 'command'
  | 'fileChange'
  | 'permissions'
  | 'question'
  | 'elicitation'

/**
 * waiting：还在等人答；resolved：有了结果（有人答了，或者回合结束、连接断了作废了）；
 * autoDeclined：等满时限没人答，设备服务替人拒绝了（提问是全部跳过，MCP 征询是拒绝）
 */
export type TaskRunApprovalState = 'waiting' | 'resolved' | 'autoDeclined'

export interface TaskRunApproval {
  /** 引擎发来的请求号（转成字符串） */
  requestId: string
  kind: TaskRunApprovalKind
  /** 一句话说是什么：命令原文、改文件的理由、要的权限、第一道题、MCP 服务名加说明。最多 TASK_RUN_APPROVAL_TITLE_MAX 个字 */
  title: string
  requestedAt: number
  /** 到这个时间还没人答就自动拒绝 */
  declineAt: number
  state: TaskRunApprovalState
  /** 有结果、被自动拒绝的时间；还在等是 null */
  settledAt: number | null
}

/** 审批的一句话最多留多少个字 */
export const TASK_RUN_APPROVAL_TITLE_MAX = 200
/** 一次运行最多记这么多条审批，多的只答不记 */
export const TASK_RUN_APPROVALS_MAX = 50

/** 运行记录里摘要最多留多少个字 */
export const TASK_RUN_SUMMARY_MAX = 500

/** 运行失败的原因 */
export const TASK_RUN_ERROR = {
  /** 那个 harness 现在不可用（没启用、起不来） */
  harnessUnavailable: 'harnessUnavailable',
  /** 目标会话没了（删了、找不到） */
  threadMissing: 'threadMissing',
  /** 工作目录不存在 */
  cwdMissing: 'cwdMissing',
  /** 回合本身失败了（模型出错、被打断） */
  turnFailed: 'turnFailed',
  /** 回合超过了时限，被打断 */
  timedOut: 'timedOut',
  /** 设备服务在回合跑完之前退出了，之后查不到结果 */
  interrupted: 'interrupted',
  /** 别的 */
  internal: 'internal',
} as const

export type TaskRunErrorCode = keyof typeof TASK_RUN_ERROR

// ---------- 方法 ----------

/** 列出设备上的全部任务，按建的先后 */
export const DEVICE_TASK_LIST = 'litch/task/list'

export interface DeviceTaskListResponse {
  data: DeviceTask[]
}

export const DEVICE_TASK_CREATE = 'litch/task/create'

export interface DeviceTaskCreateParams {
  name: string
  prompt: string
  schedule: TaskSchedule
  /** 不给是设备所在的时区 */
  timezone?: string | null
  target: TaskTarget
  /** 不给是 active */
  status?: 'active' | 'paused' | null
}

export interface DeviceTaskResponse {
  task: DeviceTask
}

export const DEVICE_TASK_UPDATE = 'litch/task/update'

/** 只改给了的那几项。target 只能改 newThread 的 cwd、workspaceId、settings */
export interface DeviceTaskUpdateParams {
  id: string
  revision: number
  name?: string
  prompt?: string
  schedule?: TaskSchedule
  timezone?: string
  /** completed 的任务改回 active 时日程从现在往后算 */
  status?: TaskStatus
  target?: {
    cwd?: string
    workspaceId?: string | null
    settings?: TaskSessionSettings
    /** 每次在新工作树里跑；false 是关掉 */
    worktree?: boolean
  }
}

/** 删掉任务和它的运行记录。正在跑的那一次不打断，跑完不再记 */
export const DEVICE_TASK_DELETE = 'litch/task/delete'

export interface DeviceTaskIdParams {
  id: string
}

/** 立即运行一次，不影响日程。已经有一次在跑（或者在排队）就不另起，回的是那一次 */
export const DEVICE_TASK_RUN_NOW = 'litch/task/runNow'

export interface DeviceTaskRunNowResponse {
  run: DeviceTaskRun
  /** 回的是已经在跑的那一次 */
  deduplicated: boolean
}

/** 运行记录，新的在前 */
export const DEVICE_TASK_RUNS_LIST = 'litch/task/runs/list'

export interface DeviceTaskRunsListParams {
  /** 只列这个任务的；不给是全部任务的 */
  taskId?: string | null
  /** 不给是 50，最多 200 */
  limit?: number | null
  /** 上一页应答里的 nextCursor */
  cursor?: string | null
}

export interface DeviceTaskRunsListResponse {
  data: DeviceTaskRun[]
  /** 还有更早的就有它 */
  nextCursor: string | null
}

/** 标成看过了。给 runIds 只标这几条；只给 taskId 标这个任务的全部；都不给标全部 */
export const DEVICE_TASK_RUNS_MARK_READ = 'litch/task/runs/markRead'

export interface DeviceTaskRunsMarkReadParams {
  taskId?: string | null
  runIds?: string[] | null
}

// ---------- 通知 ----------

/** 任务多了、变了、没了（包括下一次运行时间、未读数这些跟着运行变的字段）。只发给声明过 deviceTasks 的连接，每条都发 */
export const DEVICE_TASK_CHANGED = 'litch/task/changed'

export interface DeviceTaskChangedNotification {
  change: 'created' | 'updated' | 'deleted'
  taskId: string
  /** 变化之后的样子；deleted 时是 null */
  task: DeviceTask | null
}

/** 一次运行开始、结束、标成看过了。只发给声明过 deviceTasks 的连接 */
export const DEVICE_TASK_RUN_CHANGED = 'litch/task/run/changed'

export interface DeviceTaskRunChangedNotification {
  run: DeviceTaskRun
}

// ---------- 错误 ----------

/**
 * 这个扩展自己回的错误，原因在 `error.data.litch` 里。都用标准码，只认标准错误码的客户端照样能处理。
 * 没声明扩展的连接调这几个方法，回的是 harness 扩展里的 extensionRequired。
 */
export const DEVICE_TASK_ERROR_CODE = {
  /** 没有这个任务 */
  unknownTask: -32602,
  /** revision 对不上：别处先改了。错误里带最新的任务 */
  taskConflict: -32600,
  /** 字段不对：名字或提示词太长太短、日程或时区不合法、改了不让改的 target 字段 */
  invalidTask: -32602,
  /** target 指的 harness 不是这台设备上配置的、或者不支持建会话；会话不存在 */
  invalidTarget: -32602,
  /** 设备上的任务数到了上限（TASK_LIMIT） */
  taskLimitReached: -32061,
} as const

export type DeviceTaskErrorReason = keyof typeof DEVICE_TASK_ERROR_CODE

export interface DeviceTaskErrorData {
  litch: DeviceTaskErrorReason
  taskId?: string
  /** taskConflict：最新的任务 */
  task?: DeviceTask
  /** invalidTask、invalidTarget：哪个字段 */
  field?: string
}

/** 一台设备上最多这么多个任务 */
export const TASK_LIMIT = 200
/** 名字、提示词的长度上限（按 UTF-16 码元数） */
export const TASK_NAME_MAX = 120
export const TASK_PROMPT_MAX = 100_000
