// 定时任务的调度：按 nextRunAt 设定时器，到点排一次运行，按并发上限一次次开始，跑完记结果。
// 规矩（protocol/extensions/device-tasks.json 的 rules）：
//   - 错过了不止一个时间点只跑一次，coalesced 记下合并了几个，下一次从现在往后算；
//   - 同一个任务同时只有一次运行，到点时上一次还没结束，这个时间点记到下一次的 coalesced 里；
//   - 整台设备同时在跑的有上限，多的排着，按计划时间先后开始；
//   - 同一个时间点只跑一次：排运行和推进 nextRunAt 在一个事务里，外加触发键（任务、revision、时间点）唯一，
//     设备进程重启也不会再跑。
// 定时器不按固定间隔轮询，只等到最近的那个 nextRunAt；但最长等 maxTimerMs 就醒来看一眼墙钟：
// 机器睡眠时单调时钟停着，到点的定时器会晚，醒来时比预期晚很多就当作睡眠醒来，按错过合并。
import { randomUUID } from 'node:crypto'
import type { DeviceTaskRun, TaskRunApproval } from '../../protocol/src/device-tasks.mjs'
import { countTaskRuns, nextTaskRun } from '../../protocol/src/task-schedule.mjs'
import type { EngineLink } from './engine-link.mjs'
import { DEFAULT_APPROVAL_TIMEOUT_MINUTES, guardApprovals } from './task-approvals.mjs'
import { type FollowUpdate, followBackground } from './task-follow.mjs'
import {
  executeRun,
  RunFailure,
  type RunHost,
  type RunOutcome,
  recoverRun,
  summaryOf,
  type TaskTiming,
} from './task-run.mjs'
import { publicRun, type RunRow, type TaskRow, type TaskStore } from './task-store.mjs'
import type { TaskTurns } from './task-turns.mjs'

/** 设置里的几项（Go 层 settings_tasks.go，经控制通道推来） */
export interface TaskSettings {
  /** 总开关。关着时不按日程触发；已经排上的、立即运行的照跑 */
  enabled: boolean
  /** 整台设备同时在跑的运行最多几个 */
  maxConcurrent: number
  /** 回合里要人答的请求等多久（分钟）没人答就替人拒绝（task-approvals.mts） */
  approvalTimeoutMinutes: number
}

export const DEFAULT_TASK_SETTINGS: TaskSettings = {
  enabled: true,
  maxConcurrent: 2,
  approvalTimeoutMinutes: DEFAULT_APPROVAL_TIMEOUT_MINUTES,
}

/** 时间从哪来、定时器怎么设。测试换成可控的 */
export interface TaskClock {
  /** 毫秒 */
  now(): number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export const SYSTEM_CLOCK: TaskClock = {
  now: () => Date.now(),
  setTimer: (run, ms) => {
    const timer = setTimeout(run, ms)
    // 定时任务不该让一个本来要退出的进程留着
    timer.unref()
    return timer
  },
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

/** 定时器最长等这么久就醒来看一眼墙钟 */
export const MAX_TIMER_MS = 5 * 60 * 1000
/** 定时器比预期晚这么多算睡眠醒来（只记日志，合并的算法本来就按墙钟） */
const LATE_MS = 60 * 1000

export interface SchedulerHost {
  store: TaskStore
  clock: TaskClock
  timing: TaskTiming
  maxTimerMs: number
  /** 开一条内部连接（见 RunHost.openEngineLink） */
  openEngineLink(harness: string): Promise<EngineLink>
  /** 见 RunHost.backgroundRunning */
  backgroundRunning(threadId: string): number
  /** 后台任务跑完了引擎会不会自己接着做（background.mts 的 wakes） */
  backgroundWakes(threadId: string): boolean
  log(line: string): void
  /** 任务的字段变了（下一次运行时间、最近一次运行、未读数……） */
  taskChanged(taskId: string): void
  runChanged(run: DeviceTaskRun): void
  born(harness: string, thread: Record<string, unknown>, workspaceId: string | null): void
  turns: TaskTurns
}

const seconds = (ms: number): number => Math.floor(ms / 1000)

/** 跑的过程中抛出来的换成运行的结果 */
function failure(error: unknown): RunOutcome {
  const message = error instanceof Error ? error.message : String(error)
  return {
    status: 'failed',
    summary: null,
    error: { code: error instanceof RunFailure ? error.code : 'internal', message },
  }
}

export class TaskScheduler {
  private readonly host: SchedulerHost
  private settings: TaskSettings = { ...DEFAULT_TASK_SETTINGS }
  private timer: unknown = null
  /** 排着的运行 */
  private readonly queue = new Set<string>()
  /** 正在跑的运行（含设备进程重启后接着等的） */
  private readonly executing = new Map<string, Promise<void>>()
  /** 结束后还在盯着后台任务的运行（停下的办法） */
  private readonly follows = new Set<() => void>()
  private closed = false
  private started = false

  constructor(host: SchedulerHost) {
    this.host = host
  }

  /** 正在跑的运行有几个（device-stop --if-idle 看它） */
  get running(): number {
    return this.executing.size
  }

  /** 设备进程起来：上一次没跑完的去查结果，排着的接着排，再排日程 */
  start(settings: TaskSettings): void {
    this.settings = { ...settings }
    this.started = true
    const { store } = this.host
    for (const run of store.runsIn(['running'])) this.recover(run)
    for (const run of store.runsIn(['queued'])) this.queue.add(run.id)
    this.tick(null)
  }

  /** 设置变了。总开关从关到开：关着的那段时间错过的不补，从现在往后算 */
  setSettings(settings: TaskSettings): void {
    const reopened = !this.settings.enabled && settings.enabled
    this.settings = { ...settings }
    if (!this.started || this.closed) return
    if (reopened) this.skipMissed()
    this.arm()
    this.pump()
  }

  /** 任务建了、改了、删了：重新定时 */
  reschedule(): void {
    if (this.started && !this.closed) this.arm()
  }

  /** 这个任务删了：排着的那一次不跑了（记录已经随任务删掉） */
  forget(taskId: string, runs: readonly string[]): void {
    void taskId
    for (const id of runs) this.queue.delete(id)
    this.reschedule()
  }

  /** 立即运行一次。已经有一次排着或者在跑，回那一次 */
  runNow(task: TaskRow): { run: DeviceTaskRun; deduplicated: boolean } {
    const { store } = this.host
    const active = store.activeRun(task.id)
    if (active) return { run: publicRun(active), deduplicated: true }
    const run = this.newRun(task, 'manual', seconds(this.host.clock.now()), 0)
    store.insertRun(run, null)
    this.host.runChanged(run)
    this.host.taskChanged(task.id)
    this.queue.add(run.id)
    this.pump()
    return { run, deduplicated: false }
  }

  /** 不再排、不再记。正在用的内部连接由设备进程随后关掉（运行留着 running，下次起来去查） */
  close(): void {
    this.closed = true
    if (this.timer !== null) this.host.clock.clearTimer(this.timer)
    this.timer = null
    for (const stop of [...this.follows]) stop()
  }

  private newRun(
    task: TaskRow,
    trigger: DeviceTaskRun['trigger'],
    scheduledFor: number,
    coalesced: number,
  ): DeviceTaskRun {
    return {
      id: randomUUID(),
      taskId: task.id,
      trigger,
      scheduledFor,
      coalesced,
      status: 'queued',
      harness: task.target.harness,
      threadId: task.target.kind === 'thread' ? task.target.threadId : null,
      turnId: null,
      startedAt: null,
      finishedAt: null,
      summary: null,
      error: null,
      read: true,
    }
  }

  // ---------- 执行 ----------

  /** 有空位就按计划时间先后开始排着的 */
  private pump(): void {
    if (this.closed) return
    const { store } = this.host
    while (this.executing.size < this.settings.maxConcurrent && this.queue.size > 0) {
      const waiting = [...this.queue]
        .map((id) => store.run(id))
        .filter((run): run is RunRow => run !== null && run.status === 'queued')
      // 任务删了、运行已经不在排着的，清出去
      for (const id of [...this.queue])
        if (!waiting.some((run) => run.id === id)) this.queue.delete(id)
      const next = waiting.sort((a, b) => a.scheduledFor - b.scheduledFor || a.seq - b.seq)[0]
      if (!next) return
      this.queue.delete(next.id)
      this.begin(next)
    }
  }

  private runHost(): RunHost {
    const { host } = this
    return {
      now: () => host.clock.now(),
      timing: host.timing,
      log: host.log,
      progress: (run) => this.progress(run),
      born: host.born,
      openEngineLink: (harness) => host.openEngineLink(harness),
      backgroundRunning: (threadId) => host.backgroundRunning(threadId),
      turns: host.turns,
      guardApprovals: (link, run, turn) =>
        guardApprovals(
          link,
          turn,
          {
            clock: host.clock,
            timeoutMs: () => this.settings.approvalTimeoutMinutes * 60_000,
            log: host.log,
            changed: (approvals) => this.approvalsChanged(run.id, approvals),
          },
          run.approvals,
        ),
    }
  }

  /** 运行里要人答的请求有了变化（多了一条、有了结果、被自动拒绝）：记下来，告诉客户端 */
  private approvalsChanged(id: string, approvals: TaskRunApproval[]): void {
    if (this.closed) return
    const { store } = this.host
    if (!store.updateApprovals(id, approvals)) return
    const run = store.run(id)
    if (run) this.host.runChanged(publicRun(run))
  }

  private begin(run: RunRow): void {
    const task = this.host.store.task(run.taskId)
    if (!task) return
    const work = executeRun(this.runHost(), task, publicRun(run)).then(
      (outcome) => this.finish(run.id, outcome),
      (error) => this.finish(run.id, failure(error)),
    )
    this.track(run.id, work)
  }

  /** 上一次设备进程退出时还在跑的：去会话里查结果，还在跑就接着等 */
  private recover(run: RunRow): void {
    this.host.log(`任务 ${run.taskId} 的运行 ${run.id} 上一次没有跑完，去会话里查结果`)
    const work = recoverRun(this.runHost(), publicRun(run)).then(
      (outcome) => this.finish(run.id, outcome),
      (error) => this.finish(run.id, failure(error)),
    )
    this.track(run.id, work)
  }

  private track(id: string, work: Promise<void>): void {
    const done = work
      .catch((error) => this.host.log(`运行 ${id} 收尾时出错：${String(error)}`))
      .finally(() => {
        this.executing.delete(id)
        this.pump()
      })
    this.executing.set(id, done)
  }

  /** 运行有了进展（会话建好了、回合开始了）：记下来，告诉客户端 */
  private progress(run: DeviceTaskRun): void {
    if (this.closed) return
    const { store } = this.host
    // 任务已经删了：跑完不再记
    if (!store.updateRun(run)) return
    if (run.status === 'running' && run.startedAt !== null) {
      const task = store.task(run.taskId)
      if (task) {
        task.lastRunAt = run.startedAt
        store.saveTask(task)
      }
    }
    // 审批记录另外改（approvalsChanged），发出去的以库里的为准
    const stored = store.run(run.id)
    this.host.runChanged(stored ? publicRun(stored) : run)
    this.host.taskChanged(run.taskId)
  }

  /** 跑完了：记结果；任务上的最近错误、一次性任务的完成、会话没了的暂停跟着变 */
  private finish(id: string, outcome: RunOutcome): void {
    const { store, clock } = this.host
    const current = this.closed ? null : store.run(id)
    if (!current) {
      outcome.follow?.link.close()
      return
    }
    const run: DeviceTaskRun = {
      ...publicRun(current),
      status: outcome.status,
      finishedAt: seconds(clock.now()),
      summary: outcome.summary,
      error: outcome.error,
      read: false,
      ...(outcome.backgroundTasks ? { backgroundTasks: outcome.backgroundTasks } : {}),
    }
    store.transaction(() => {
      store.updateRun(run)
      const task = store.task(run.taskId)
      if (!task) return
      task.lastError = outcome.error
      if (outcome.error?.code === 'threadMissing' && task.status === 'active') {
        // 目标会话没了，以后也跑不成：暂停，等用户处理
        task.status = 'paused'
        task.nextRunAt = null
        task.pendingCoalesced = 0
        task.revision++
        task.updatedAt = run.finishedAt as number
      } else if (
        task.schedule.type === 'once' &&
        task.status === 'active' &&
        task.nextRunAt === null
      ) {
        task.status = 'completed'
        task.pendingCoalesced = 0
        task.revision++
        task.updatedAt = run.finishedAt as number
      }
      store.saveTask(task)
      store.prune(task.id)
    })
    this.host.log(
      `任务 ${run.taskId} 的运行 ${run.id} ${run.status === 'succeeded' ? '成功' : `失败（${run.error?.code}）：${run.error?.message}`}`,
    )
    this.host.runChanged(run)
    this.host.taskChanged(run.taskId)
    this.reschedule()
    if (outcome.follow) this.follow(id, outcome.follow.threadId, outcome.follow.link)
  }

  /** 运行结束时还有后台任务在跑：接着盯，续跑的回合、跑完都更新这次运行（task-follow.mts） */
  private follow(id: string, threadId: string, link: EngineLink): void {
    const { host } = this
    const stop = followBackground(
      {
        now: () => host.clock.now(),
        limitMs: host.timing.turnTimeoutMs,
        settleMs: host.timing.followSettleMs,
        backgroundRunning: (thread) => host.backgroundRunning(thread),
        backgroundWakes: (thread) => host.backgroundWakes(thread),
        summaryOf,
        log: host.log,
      },
      link,
      threadId,
      (patch) => this.followUp(id, patch),
    )
    this.follows.add(stop)
    link.onClose(() => this.follows.delete(stop))
  }

  /** 后台任务有了下文：改这次运行的摘要和后台任务数，标成没看过 */
  private followUp(id: string, patch: FollowUpdate): void {
    if (this.closed) return
    const { store } = this.host
    const current = store.run(id)
    if (!current) return
    const { backgroundTasks: _old, ...rest } = publicRun(current)
    const run: DeviceTaskRun = {
      ...rest,
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      read: false,
      ...(patch.backgroundTasks > 0 ? { backgroundTasks: patch.backgroundTasks } : {}),
    }
    if (!store.updateRun(run)) return
    this.host.log(
      `任务 ${run.taskId} 的运行 ${id} 的后台任务有了下文，还剩 ${patch.backgroundTasks} 个在跑`,
    )
    this.host.runChanged(run)
    this.host.taskChanged(run.taskId)
  }

  // ---------- 定时 ----------

  /** 定时器等到最近的那个 nextRunAt，最长 maxTimerMs */
  private arm(): void {
    const { clock, store } = this.host
    if (this.timer !== null) clock.clearTimer(this.timer)
    this.timer = null
    if (this.closed || !this.settings.enabled) return
    let due: number | null = null
    for (const task of store.tasks())
      if (task.status === 'active' && task.nextRunAt !== null)
        due = due === null ? task.nextRunAt : Math.min(due, task.nextRunAt)
    if (due === null) return
    const now = clock.now()
    const delay = Math.min(Math.max(due * 1000 - now, 0), this.host.maxTimerMs)
    const expected = now + delay
    this.timer = clock.setTimer(() => {
      this.timer = null
      this.tick(expected)
    }, delay)
  }

  /** 到点了（或者刚起来）：到了时间的任务各排一次，再定下一次的时 */
  private tick(expected: number | null): void {
    if (this.closed) return
    const { clock, store, log } = this.host
    if (expected !== null && clock.now() - expected > LATE_MS)
      log(
        `定时器比预期晚了 ${Math.round((clock.now() - expected) / 1000)} 秒，当作睡眠醒来，错过的合并`,
      )
    if (this.settings.enabled) {
      const now = seconds(clock.now())
      for (const task of store.tasks())
        if (task.status === 'active' && task.nextRunAt !== null && task.nextRunAt <= now)
          this.fire(task, now)
    }
    this.arm()
    this.pump()
  }

  /**
   * 一个任务到点了。到期的是 nextRunAt，(nextRunAt, now] 之间还有的都算错过：只跑一次，计划时间记最近的那个，
   * coalesced 是其余的个数加上之前因为上一次没跑完记下的。上一次还没结束就不另起，全部记到下一次。
   */
  private fire(task: TaskRow, now: number): void {
    const { store } = this.host
    const due = task.nextRunAt as number
    const extra = countTaskRuns(task.schedule, task.timezone, due, now, task.anchor)
    let latest = due
    for (let step = 0; step < extra; step++) {
      const next = nextTaskRun(task.schedule, task.timezone, latest, task.anchor)
      if (next === null || next > now) break
      latest = next
    }
    const next = nextTaskRun(task.schedule, task.timezone, now, task.anchor)
    let created: DeviceTaskRun | null = null
    store.transaction(() => {
      const fresh = store.task(task.id)
      if (!fresh || fresh.nextRunAt !== due) return
      if (store.activeRun(task.id)) {
        fresh.pendingCoalesced += 1 + extra
      } else {
        const run = this.newRun(fresh, 'scheduled', latest, extra + fresh.pendingCoalesced)
        // 触发键用过了：这个时间点已经跑过（不该发生，守着重启和时钟回拨）
        if (store.insertRun(run, `${fresh.id}:${fresh.revision}:${latest}`)) created = run
        fresh.pendingCoalesced = 0
      }
      fresh.nextRunAt = next
      store.saveTask(fresh)
    })
    const run = created as DeviceTaskRun | null
    if (run) {
      this.host.runChanged(run)
      this.queue.add(run.id)
    }
    this.host.taskChanged(task.id)
  }

  /** 总开关关着的那段时间到了的时间点不补：从现在往后算 */
  private skipMissed(): void {
    const { clock, store } = this.host
    const now = seconds(clock.now())
    for (const task of store.tasks()) {
      if (task.status !== 'active' || task.nextRunAt === null || task.nextRunAt > now) continue
      // 一次性的只有这一次，跳过就再也不跑了：照常补跑
      if (task.schedule.type === 'once') continue
      task.nextRunAt = nextTaskRun(task.schedule, task.timezone, now, task.anchor)
      task.pendingCoalesced = 0
      store.saveTask(task)
      this.host.taskChanged(task.id)
    }
  }
}
