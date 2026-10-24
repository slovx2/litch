// 定时任务（协议扩展 deviceTasks，定义在 protocol/extensions/device-tasks.json）：设备进程里的任务模块，
// 和终端、工作区并列。任务和运行记录存在 tasks.sqlite（task-store.mts），按日程由 task-scheduler.mts 触发，
// 一次运行怎么驱动引擎在 task-run.mts。这里是客户端的方法（litch/task/*）和通知，以及给 litch_tasks 工具用的那几样操作。
import { randomUUID } from 'node:crypto'
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  DEVICE_TASK_CHANGED,
  DEVICE_TASK_CREATE,
  DEVICE_TASK_DELETE,
  DEVICE_TASK_LIST,
  DEVICE_TASK_RUN_CHANGED,
  DEVICE_TASK_RUN_NOW,
  DEVICE_TASK_RUNS_LIST,
  DEVICE_TASK_RUNS_MARK_READ,
  DEVICE_TASK_UPDATE,
  type DeviceTask,
  type DeviceTaskChangedNotification,
  type DeviceTaskRun,
  type DeviceTaskRunNowResponse,
  type DeviceTaskRunsListResponse,
  TASK_LIMIT,
  type TaskOrigin,
  type TaskSchedule,
  type TaskStatus,
  type TaskTarget,
} from '../../protocol/src/device-tasks.mjs'
import { localTaskTimeZone, nextTaskRun } from '../../protocol/src/task-schedule.mjs'
import type { EngineLink } from './engine-link.mjs'
import type { HarnessSource } from './session.mjs'
import { openSideLink } from './side-link.mjs'
import { DEFAULT_TASK_TIMING, type TaskTiming } from './task-run.mjs'
import {
  DEFAULT_TASK_SETTINGS,
  MAX_TIMER_MS,
  SYSTEM_CLOCK,
  type TaskClock,
  TaskScheduler,
  type TaskSettings,
} from './task-scheduler.mjs'
import { openTaskDatabase, publicRun, type TaskRow, TaskStore } from './task-store.mjs'
import { TaskTurns } from './task-turns.mjs'
import {
  badTarget,
  checkSchedule,
  conflict,
  DeviceTaskError,
  invalid,
  optionalStatus,
  requiredId,
  sessionSettings,
  taskCwd,
  taskName,
  taskPrompt,
  unknownTask,
} from './task-validate.mjs'
import type { ThreadIndex } from './thread-index.mjs'
import { DeviceError, isObject } from './wire.mjs'
import type { Workspaces } from './workspaces.mjs'
import type { Worktrees } from './worktrees.mjs'

/** 这个扩展的方法都在这个前缀下，由设备进程自己处理 */
export const DEVICE_TASK_PREFIX = 'litch/task/'

export interface DeviceTasksOptions {
  stateDir: string
  harnesses(): HarnessSource[]
  index: ThreadIndex
  workspaces: Workspaces
  /** 发给所有握手时声明过这个扩展的连接 */
  announce(method: string, params: unknown, extension: string): void
  log(line: string): void
  version: string
  clock?: TaskClock
  timing?: Partial<TaskTiming>
  /** 定时器最长等多久就醒来看一眼墙钟（毫秒），见 task-scheduler.mts */
  maxTimerMs?: number
  /** 开一条内部连接（DeviceServer.openEngineLink）：跑任务、核对会话在不在 */
  openEngineLink(harness: string): Promise<EngineLink>
  /** 会话里还有几个后台任务在跑（background.mts）。不给当 0 */
  backgroundRunning?(threadId: string): number
  /** 后台任务跑完了引擎会不会自己接着做。不给当不会 */
  backgroundWakes?(threadId: string): boolean
  /** 设备层的工作树（每次在新工作树里跑的任务用）。没有 git、不给时是 null */
  worktrees?(): Worktrees | null
}

const seconds = (ms: number): number => Math.floor(ms / 1000)

/** litch/task/runs/list 一页默认几条、最多几条 */
const RUNS_PAGE = 50
const RUNS_PAGE_MAX = 200

/** 建任务时 target 以外的字段（客户端和 litch_tasks 工具共用） */
export interface TaskDraft {
  name?: unknown
  prompt?: unknown
  schedule?: unknown
  timezone?: unknown
  status?: unknown
}

export class DeviceTasks {
  private readonly options: DeviceTasksOptions
  readonly store: TaskStore
  private readonly scheduler: TaskScheduler
  private readonly clock: TaskClock
  private readonly timing: TaskTiming
  private readonly turns = new TaskTurns()
  private begun = false
  private closed = false

  /** 打开任务库失败（库比这一版新、文件坏了）时返回 null，设备进程照常运行，只是没有定时任务 */
  static open(options: DeviceTasksOptions): DeviceTasks | null {
    try {
      return new DeviceTasks(options, new TaskStore(openTaskDatabase(options.stateDir)))
    } catch (error) {
      options.log(`定时任务不可用：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  private constructor(options: DeviceTasksOptions, store: TaskStore) {
    this.options = options
    this.store = store
    this.clock = options.clock ?? SYSTEM_CLOCK
    this.timing = { ...DEFAULT_TASK_TIMING, ...options.timing }
    this.scheduler = new TaskScheduler({
      store,
      clock: this.clock,
      timing: this.timing,
      maxTimerMs: options.maxTimerMs ?? MAX_TIMER_MS,
      openEngineLink: (harness) => options.openEngineLink(harness),
      backgroundRunning: (threadId) => options.backgroundRunning?.(threadId) ?? 0,
      backgroundWakes: (threadId) => options.backgroundWakes?.(threadId) ?? false,
      log: options.log,
      taskChanged: (id) => this.changed('updated', id),
      runChanged: (run) => this.runChanged(run),
      born: (harness, thread, workspaceId) => this.born(harness, thread, workspaceId),
      turns: this.turns,
      worktrees: () => options.worktrees?.() ?? null,
    })
  }

  /** 这个回合是定时任务发起的（会话树用它决定子会话的回合要不要唤醒父会话） */
  isTaskTurn(threadId: string, turnId: string): boolean {
    return this.turns.has(threadId, turnId)
  }

  /**
   * 开始排日程（上一次没跑完的也在这时去查）。设备进程等适配器主进程把设置送过来再开始，
   * 免得总开关关着时刚起来就把错过的补跑了
   */
  begin(settings: TaskSettings = DEFAULT_TASK_SETTINGS): void {
    if (this.begun || this.closed) return
    this.begun = true
    this.scheduler.start(settings)
  }

  /** 在跑的运行有几个 */
  get running(): number {
    return this.scheduler.running
  }

  /** 设置变了。还没开始的，照这份开始 */
  setSettings(settings: TaskSettings): void {
    if (!this.begun) this.begin(settings)
    else this.scheduler.setSettings(settings)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.scheduler.close()
    this.store.close()
  }

  /** 客户端调这个扩展的一个方法。declared：这条连接握手时声明了 deviceTasks */
  call(method: string, params: unknown, declared: boolean): unknown {
    if (!declared)
      throw new DeviceError(
        'extensionRequired',
        `${method} 属于 ${EXTENSION.deviceTasks} 扩展，握手时在 capabilities.litchExtensions 里声明了它才能用`,
        { method, required: [EXTENSION.deviceTasks] },
      )
    const fields = isObject(params) ? params : {}
    switch (method) {
      case DEVICE_TASK_LIST:
        return { data: this.list() }
      case DEVICE_TASK_CREATE:
        return this.createFromClient(fields).then((task) => ({ task }))
      case DEVICE_TASK_UPDATE:
        return this.update(fields).then((task) => ({ task }))
      case DEVICE_TASK_DELETE:
        this.delete(requiredId(fields.id, 'id'))
        return {}
      case DEVICE_TASK_RUN_NOW:
        return this.runNow(requiredId(fields.id, 'id'))
      case DEVICE_TASK_RUNS_LIST:
        return this.runs(fields)
      case DEVICE_TASK_RUNS_MARK_READ:
        this.markRead(fields)
        return {}
      default:
        throw new DeviceError('unsupported', `聚合面不支持 ${method}：设备上没有这个任务方法`, {
          method,
        })
    }
  }

  // ---------- 读 ----------

  list(): DeviceTask[] {
    return this.store.tasks().map((row) => this.describe(row))
  }

  /** 协议里的任务对象 */
  describe(row: TaskRow): DeviceTask {
    const last = this.store.lastRun(row.id)
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      schedule: row.schedule,
      timezone: row.timezone,
      status: row.status,
      target: row.target,
      origin: row.origin,
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      nextRunAt: row.status === 'active' ? row.nextRunAt : null,
      lastRunAt: row.lastRunAt,
      lastRun: last ? publicRun(last) : null,
      lastError: row.lastError,
      unreadRuns: this.store.unread(row.id),
    }
  }

  task(id: string): TaskRow {
    const row = this.store.task(id)
    if (!row) throw unknownTask(id)
    return row
  }

  // ---------- 写 ----------

  private async createFromClient(fields: Record<string, unknown>): Promise<DeviceTask> {
    // 先看能不能再建、别的字段对不对，再去问引擎会话在不在（那要开连接）
    this.checkDraft(fields)
    const target = await this.target(fields.target)
    return this.create(fields, target, { kind: 'client' })
  }

  /** 名字、提示词、日程、时区、状态对不对，任务数到没到上限。返回定下来的时区 */
  private checkDraft(draft: TaskDraft): string {
    if (this.store.count() >= TASK_LIMIT)
      throw new DeviceTaskError(
        'taskLimitReached',
        `This device already has ${TASK_LIMIT} tasks, which is the limit`,
      )
    taskName(draft.name)
    taskPrompt(draft.prompt)
    const timezone = draft.timezone == null ? localTaskTimeZone() : draft.timezone
    checkSchedule(draft.schedule, timezone)
    optionalStatus(draft.status, ['active', 'paused'] as const)
    return timezone as string
  }

  /** 新建一个任务。target 已经校验过 */
  create(draft: TaskDraft, target: TaskTarget, origin: TaskOrigin): DeviceTask {
    const timezone = this.checkDraft(draft)
    const status: TaskStatus =
      optionalStatus(draft.status, ['active', 'paused'] as const) ?? 'active'
    const schedule = draft.schedule as TaskSchedule
    const now = seconds(this.clock.now())
    const nextRunAt = status === 'active' ? nextTaskRun(schedule, timezone, now, now) : null
    if (status === 'active' && nextRunAt === null)
      throw invalid('schedule', 'The schedule has no run after now')
    const row: TaskRow = {
      id: randomUUID(),
      seq: this.store.nextSeq(),
      name: draft.name as string,
      prompt: draft.prompt as string,
      schedule,
      timezone,
      status,
      target,
      origin,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      anchor: now,
      nextRunAt,
      lastRunAt: null,
      lastError: null,
      pendingCoalesced: 0,
    }
    this.store.saveTask(row)
    this.changed('created', row.id)
    this.scheduler.reschedule()
    return this.describe(row)
  }

  /** 客户端给的 target：harness 要是这台设备上配置的，thread 目标的会话要真有 */
  async target(value: unknown): Promise<TaskTarget> {
    if (!isObject(value)) throw invalid('target', 'target must be an object')
    const harness = requiredId(value.harness, 'target.harness')
    if (!this.options.harnesses().some((source) => source.id === harness))
      throw badTarget('target.harness', `No harness ${harness} is configured on this device`)
    if (value.kind === 'newThread') {
      const workspaceId =
        value.workspaceId == null ? null : requiredId(value.workspaceId, 'target.workspaceId')
      if (workspaceId !== null) this.requireWorkspace(workspaceId)
      const cwd = taskCwd(value.cwd)
      const worktree = optionalWorktree(value.worktree)
      if (worktree) await this.requireRepo(cwd)
      return {
        kind: 'newThread',
        harness,
        cwd,
        workspaceId,
        settings: sessionSettings(value.settings),
        ...(worktree ? { worktree } : {}),
      }
    }
    if (value.kind === 'thread') {
      const threadId = requiredId(value.threadId, 'target.threadId')
      await this.requireThread(harness, threadId)
      return { kind: 'thread', harness, threadId }
    }
    throw invalid('target.kind', 'target.kind must be newThread or thread')
  }

  /** 每次在新工作树里跑：设备要能建工作树、目录要在 git 仓库里 */
  private async requireRepo(cwd: string): Promise<void> {
    const worktrees = this.options.worktrees?.() ?? null
    if (!worktrees)
      throw badTarget('target.worktree', 'This device cannot make worktrees (git is not available)')
    try {
      await worktrees.branches(cwd)
    } catch {
      throw badTarget(
        'target.worktree',
        `${cwd} is not in a git repository, so the task cannot run in a new worktree`,
      )
    }
  }

  private requireWorkspace(workspaceId: string): void {
    try {
      this.options.workspaces.requireProject(workspaceId)
    } catch {
      throw badTarget('target.workspaceId', `There is no workspace ${workspaceId} on this device`)
    }
  }

  /** 会话在不在这个 harness 上：索引里有就算，没有就去问它一句 */
  private async requireThread(harness: string, threadId: string): Promise<void> {
    const known = this.options.index.lookup(threadId)
    if (known === harness) return
    if (known !== null)
      throw badTarget('target.threadId', `Thread ${threadId} belongs to ${known}, not ${harness}`)
    const source = this.options.harnesses().find((item) => item.id === harness)
    let thread: Record<string, unknown> | null = null
    try {
      if (!source) throw new Error('not configured')
      const link = await openSideLink(
        source.connect,
        this.options.version,
        this.timing.handshakeTimeoutMs,
      )
      try {
        const read = await link.call('thread/read', { threadId, includeTurns: false })
        thread = isObject(read) && isObject(read.thread) ? read.thread : null
      } finally {
        link.close()
      }
    } catch {
      thread = null
    }
    if (thread?.id !== threadId)
      throw badTarget('target.threadId', `There is no thread ${threadId} on ${harness}`)
    this.options.index.see(
      { id: threadId, updatedAt: thread.updatedAt, ephemeral: thread.ephemeral },
      harness,
    )
  }

  async update(fields: Record<string, unknown>): Promise<DeviceTask> {
    const row = this.task(requiredId(fields.id, 'id'))
    if (fields.revision !== row.revision) {
      if (!Number.isInteger(fields.revision))
        throw invalid('revision', 'revision must be an integer')
      throw conflict(this.describe(row))
    }
    const now = seconds(this.clock.now())
    const next: TaskRow = { ...row }
    if (fields.name !== undefined) next.name = taskName(fields.name)
    if (fields.prompt !== undefined) next.prompt = taskPrompt(fields.prompt)
    let rescheduled = false
    if (fields.schedule !== undefined || fields.timezone !== undefined) {
      const schedule = fields.schedule ?? row.schedule
      const timezone = fields.timezone ?? row.timezone
      checkSchedule(schedule, timezone)
      next.schedule = schedule as TaskSchedule
      next.timezone = timezone as string
      next.anchor = now
      rescheduled = true
    }
    const status = optionalStatus(fields.status, ['active', 'paused', 'completed'] as const)
    if (status !== null) next.status = status
    if (fields.target !== undefined) {
      next.target = this.retarget(row.target, fields.target)
      if (next.target.kind === 'newThread' && next.target.worktree)
        await this.requireRepo(next.target.cwd)
    }
    if (next.status !== 'active') {
      next.nextRunAt = null
      next.pendingCoalesced = 0
    } else if (rescheduled || row.status !== 'active') {
      next.nextRunAt = nextTaskRun(next.schedule, next.timezone, now, next.anchor)
      if (next.nextRunAt === null) throw invalid('schedule', 'The schedule has no run after now')
    }
    next.revision = row.revision + 1
    next.updatedAt = now
    this.store.saveTask(next)
    this.changed('updated', next.id)
    this.scheduler.reschedule()
    return this.describe(next)
  }

  /** 改 target：只能改 newThread 的 cwd、workspaceId、settings、worktree */
  private retarget(current: TaskTarget, value: unknown): TaskTarget {
    if (!isObject(value)) throw invalid('target', 'target must be an object')
    for (const key of Object.keys(value))
      if (
        current.kind !== 'newThread' ||
        !['cwd', 'workspaceId', 'settings', 'worktree'].includes(key)
      )
        throw invalid(`target.${key}`, `target.${key} cannot be changed`)
    if (current.kind !== 'newThread') return current
    const next = { ...current }
    if (value.cwd !== undefined) next.cwd = taskCwd(value.cwd)
    if (value.workspaceId !== undefined) {
      next.workspaceId =
        value.workspaceId === null ? null : requiredId(value.workspaceId, 'target.workspaceId')
      if (next.workspaceId !== null) this.requireWorkspace(next.workspaceId)
    }
    if (value.settings !== undefined) next.settings = sessionSettings(value.settings)
    if (value.worktree !== undefined) {
      if (optionalWorktree(value.worktree)) next.worktree = true
      else delete next.worktree
    }
    return next
  }

  /** 删掉任务和它的运行记录。正在跑的那一次不打断，跑完不再记 */
  delete(id: string): void {
    this.task(id)
    const queued = this.store
      .runsIn(['queued'])
      .filter((run) => run.taskId === id)
      .map((run) => run.id)
    this.store.transaction(() => this.store.deleteTask(id))
    this.scheduler.forget(id, queued)
    this.changed('deleted', id)
  }

  runNow(id: string): DeviceTaskRunNowResponse {
    return this.scheduler.runNow(this.task(id))
  }

  private runs(fields: Record<string, unknown>): DeviceTaskRunsListResponse {
    const taskId = fields.taskId == null ? null : requiredId(fields.taskId, 'taskId')
    if (taskId !== null) this.task(taskId)
    let limit = RUNS_PAGE
    if (fields.limit != null) {
      if (!Number.isInteger(fields.limit) || (fields.limit as number) < 1)
        throw invalid('limit', 'limit must be a positive integer')
      limit = Math.min(fields.limit as number, RUNS_PAGE_MAX)
    }
    let before: number | null = null
    if (fields.cursor != null) {
      if (typeof fields.cursor !== 'string' || !/^[1-9]\d*$/.test(fields.cursor))
        throw invalid('cursor', 'cursor must be the nextCursor of a previous page')
      before = Number(fields.cursor)
    }
    const rows = this.store.runs({ taskId, limit: limit + 1, before })
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      data: page.map((row) => publicRun(row)),
      nextCursor: rows.length > limit && last ? String(last.seq) : null,
    }
  }

  private markRead(fields: Record<string, unknown>): void {
    const taskId = fields.taskId == null ? null : requiredId(fields.taskId, 'taskId')
    let runIds: string[] | null = null
    if (fields.runIds != null) {
      if (!Array.isArray(fields.runIds) || fields.runIds.some((id) => typeof id !== 'string'))
        throw invalid('runIds', 'runIds must be an array of strings')
      runIds = fields.runIds as string[]
    }
    if (taskId !== null && runIds === null) this.task(taskId)
    const marked = this.store.markRead(taskId, runIds)
    for (const run of marked) this.runChanged(publicRun(run))
    for (const id of new Set(marked.map((run) => run.taskId))) this.changed('updated', id)
  }

  // ---------- 通知 ----------

  private changed(change: DeviceTaskChangedNotification['change'], taskId: string): void {
    if (this.closed) return
    const row = change === 'deleted' ? null : this.store.task(taskId)
    if (change !== 'deleted' && !row) return
    const params: DeviceTaskChangedNotification = {
      change,
      taskId,
      task: row ? this.describe(row) : null,
    }
    this.options.announce(DEVICE_TASK_CHANGED, params, EXTENSION.deviceTasks)
  }

  private runChanged(run: DeviceTaskRun): void {
    if (this.closed) return
    this.options.announce(DEVICE_TASK_RUN_CHANGED, { run }, EXTENSION.deviceTasks)
  }

  /** 任务新建出来的会话：登记进索引（路由要用），归进工作区 */
  private born(harness: string, thread: Record<string, unknown>, workspaceId: string | null): void {
    const id = thread.id as string
    this.options.index.see(
      { id, updatedAt: thread.updatedAt, ephemeral: thread.ephemeral },
      harness,
    )
    if (workspaceId !== null) this.options.workspaces.adoptThread(id, workspaceId)
  }
}

/** target.worktree：不给、null 是 false */
function optionalWorktree(value: unknown): boolean {
  if (value == null) return false
  if (typeof value !== 'boolean')
    throw invalid('target.worktree', 'target.worktree must be a boolean')
  return value
}
