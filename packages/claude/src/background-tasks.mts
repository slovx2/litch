// 后台任务的集合（backgroundTasks 扩展，protocol/extensions/background-tasks.json）：从 CLI 的
// background_tasks_changed（存活的全部后台任务，整体替换）、task_started / task_updated / task_notification
// （开始、改动、结束）里攒出每个会话“有哪些后台任务、各是什么状态”。成员以 background_tasks_changed 为准，
// 状态以结束通知为准；两者的先后 SDK 不保证（实际上电平信号在前）。结束过的只放内存，最多留 BACKGROUND_ENDED_LIMIT 个。
import {
  type BackgroundTaskKind,
  type BackgroundTaskStatus,
  type LitchBackgroundTask,
  orderBackgroundTasks,
} from '../../protocol/src/background-tasks.mjs'

interface TrackedTask {
  id: string
  taskType: string
  kind: BackgroundTaskKind
  description: string
  status: BackgroundTaskStatus
  toolUseId: string | null
  itemId: string | null
  turnId: string | null
  command: string | null
  startedAt: number
  endedAt: number | null
}

/** 维护性的、不算“活动”的任务类型，和 ambient 的一样不进集合 */
const HOUSEKEEPING = new Set(['dream', 'auto_mode_scan', 'local_memory_import'])

/** CLI 的任务类型到集合里的种类 */
export function backgroundTaskKind(taskType: string, shellKind?: unknown): BackgroundTaskKind {
  if (taskType === 'local_bash') return shellKind === 'monitor' ? 'monitor' : 'shell'
  if (taskType.startsWith('monitor_')) return 'monitor'
  if (taskType === 'local_agent') return 'agent'
  if (taskType === 'local_workflow') return 'workflow'
  if (taskType === 'remote_agent') return 'remote'
  return 'other'
}

/** background_tasks_changed 里的一项算不算后台活动：ambient、维护性的、别的任务名下观察用的都不算 */
export function countsAsBackground(task: Record<string, unknown>): boolean {
  if (typeof task.task_id !== 'string' || !task.task_id) return false
  if (task.ambient === true || task.observer_owned === true) return false
  return !HOUSEKEEPING.has(String(task.task_type ?? ''))
}

const endedStatus = (status: unknown): BackgroundTaskStatus | null =>
  status === 'completed'
    ? 'completed'
    : status === 'failed'
      ? 'failed'
      : status === 'stopped' || status === 'killed'
        ? 'stopped'
        : null

export class BackgroundTaskTracker {
  private readonly byThread = new Map<string, Map<string, TrackedTask>>()
  /** task_started 先到、电平信号还没把它列进来时记下的来历，键是“会话\0任务” */
  private readonly pending = new Map<
    string,
    {
      toolUseId: string | null
      taskType: string
      description: string
      startedAt: number
      turnId: string | null
    }
  >()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  private tasks(threadId: string): Map<string, TrackedTask> {
    let tasks = this.byThread.get(threadId)
    if (!tasks) {
      tasks = new Map()
      this.byThread.set(threadId, tasks)
    }
    return tasks
  }

  /**
   * CLI 的一条 system 消息。turnId 是这时占着进程的回合（任务就算在它头上）。
   * 返回集合有没有变（要不要重发）
   */
  apply(threadId: string, message: Record<string, unknown>, turnId: string | null): boolean {
    const subtype = String(message.subtype ?? '')
    if (subtype === 'background_tasks_changed' && Array.isArray(message.tasks))
      return this.level(threadId, message.tasks as Array<Record<string, unknown>>, turnId)
    const taskId = typeof message.task_id === 'string' ? message.task_id : ''
    if (!taskId) return false
    const task = this.byThread.get(threadId)?.get(taskId)
    if (subtype === 'task_started') {
      // 前台任务跑久了 CLI 也发 task_started（好让人中途转到后台）：只记下来历，进不进集合看电平信号
      if (!task) {
        if (message.ambient === true || HOUSEKEEPING.has(String(message.task_type ?? '')))
          return false
        this.pending.set(`${threadId}\u0000${taskId}`, {
          toolUseId: typeof message.tool_use_id === 'string' ? message.tool_use_id : null,
          taskType: typeof message.task_type === 'string' ? message.task_type : '',
          description: typeof message.description === 'string' ? message.description : '',
          startedAt: this.now(),
          turnId,
        })
        return false
      }
      if (typeof message.tool_use_id === 'string') task.toolUseId = message.tool_use_id
      return false
    }
    if (!task) return false
    if (subtype === 'task_updated') {
      const patch = (
        message.patch && typeof message.patch === 'object' ? message.patch : {}
      ) as Record<string, unknown>
      const status = endedStatus(patch.status)
      if (!status) return false
      // end_time 是 CLI 记的结束时刻；电平信号多半已经先把它按到达时刻收掉了，这里以 CLI 的为准
      const endTime = typeof patch.end_time === 'number' ? patch.end_time : null
      if (task.status !== 'running') {
        if (endTime === null || task.endedAt === endTime) return false
        task.endedAt = endTime
        return true
      }
      return this.end(task, status, endTime)
    }
    if (subtype === 'task_notification') {
      const status = endedStatus(message.status)
      if (!status) return false
      // 电平信号已经先把它收成了 completed：以结束通知的状态为准
      if (task.status !== 'running') {
        if (task.status === status) return false
        task.status = status
        return true
      }
      return this.end(task, status)
    }
    return false
  }

  private level(
    threadId: string,
    listed: Array<Record<string, unknown>>,
    turnId: string | null,
  ): boolean {
    const tasks = this.tasks(threadId)
    const live = new Set<string>()
    let changed = false
    for (const entry of listed) {
      if (!countsAsBackground(entry)) continue
      const id = entry.task_id as string
      live.add(id)
      const known = tasks.get(id)
      if (known) {
        // 同一个任务重新出现（比如被停又被接回）：照旧算运行中
        if (known.status !== 'running') {
          known.status = 'running'
          known.endedAt = null
          changed = true
        }
        continue
      }
      const key = `${threadId}\u0000${id}`
      const early = this.pending.get(key)
      this.pending.delete(key)
      const taskType = String(entry.task_type ?? early?.taskType ?? '')
      tasks.set(id, {
        id,
        taskType,
        kind: backgroundTaskKind(taskType, entry.shell_kind),
        description: String(entry.description ?? early?.description ?? ''),
        status: 'running',
        toolUseId: early?.toolUseId ?? null,
        itemId: null,
        turnId: early?.turnId ?? turnId,
        command: null,
        startedAt: early?.startedAt ?? this.now(),
        endedAt: null,
      })
      changed = true
    }
    // 不在了的：结束通知随后会来改成它真正的状态，先按完成算
    for (const task of tasks.values())
      if (task.status === 'running' && !live.has(task.id) && this.end(task, 'completed'))
        changed = true
    this.trim(tasks)
    return changed
  }

  private end(task: TrackedTask, status: BackgroundTaskStatus, at: number | null = null): boolean {
    if (task.status !== 'running') return false
    task.status = status
    task.endedAt = at ?? this.now()
    return true
  }

  /** CLI 进程退出了：还在跑的都随它停了。返回集合有没有变 */
  closeAll(threadId: string): boolean {
    for (const key of this.pending.keys())
      if (key.startsWith(`${threadId}\u0000`)) this.pending.delete(key)
    const tasks = this.byThread.get(threadId)
    if (!tasks) return false
    let changed = false
    for (const task of tasks.values()) if (this.end(task, 'stopped')) changed = true
    return changed
  }

  /**
   * 后台命令登记进来了（启动回执）：任务能挂回发起它的那条命令条目。返回集合有没有变。
   * 开始时间不跟条目走：条目从模型发出调用算起，含等审批的时间，任务从 CLI 真正起它算起（task_started）
   */
  link(
    threadId: string,
    taskId: string,
    fields: { itemId: string; turnId: string; command: string | null },
  ): boolean {
    const task = this.byThread.get(threadId)?.get(taskId)
    if (!task) return false
    task.itemId = fields.itemId
    task.turnId = fields.turnId
    if (fields.command) task.command = fields.command
    return true
  }

  /** 会话删掉了：结束过的也不用留了 */
  forget(threadId: string): void {
    this.byThread.delete(threadId)
    for (const key of this.pending.keys())
      if (key.startsWith(`${threadId}\u0000`)) this.pending.delete(key)
  }

  /** 有任务（运行中的或结束过的）的会话 */
  threads(): string[] {
    return [...this.byThread.keys()]
  }

  list(threadId: string): LitchBackgroundTask[] {
    const tasks = this.byThread.get(threadId)
    if (!tasks) return []
    return orderBackgroundTasks(
      [...tasks.values()].map((task) => {
        const title = (task.kind === 'shell' && task.command) || task.description || task.taskType
        return {
          id: task.id,
          kind: task.kind,
          title,
          status: task.status,
          ...(task.itemId ? { itemId: task.itemId } : {}),
          ...(task.turnId ? { turnId: task.turnId } : {}),
          startedAt: task.startedAt,
          ...(task.endedAt != null ? { endedAt: task.endedAt } : {}),
        }
      }),
    )
  }

  private trim(tasks: Map<string, TrackedTask>): void {
    const kept = new Set(orderBackgroundTasks(this.listOf(tasks)).map((task) => task.id))
    for (const id of tasks.keys()) if (!kept.has(id)) tasks.delete(id)
  }

  private listOf(tasks: Map<string, TrackedTask>): LitchBackgroundTask[] {
    return [...tasks.values()].map((task) => ({
      id: task.id,
      kind: task.kind,
      title: '',
      status: task.status,
      startedAt: task.startedAt,
      ...(task.endedAt != null ? { endedAt: task.endedAt } : {}),
    }))
  }
}
