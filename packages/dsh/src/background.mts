// dsh 的后台作业（backgroundTasks 扩展，protocol/extensions/background-tasks.json）：打开一个会话时另开一条
// job/list 流（dsh Web Remote 的 JobController，0.2.0-rc.2 起有），每帧是这个会话看得到的全部作业（整份替换）。
// 只算这个会话自己名下的（owner 是它）；子代理在 dsh 里是子会话，归会话树，不进这里。
// 作业的状态：running、stopping 算在跑，completed、failed 照搬，killed 记 stopped；在跑时从名单上消失的记 stopped。
// 结束过的只在内存里，最多留 BACKGROUND_ENDED_LIMIT 个。
import {
  type BackgroundTaskKind,
  type BackgroundTaskStatus,
  type LitchBackgroundTask,
  orderBackgroundTasks,
} from '../../protocol/src/background-tasks.mjs'

const status = (value: unknown): BackgroundTaskStatus =>
  value === 'running' || value === 'stopping'
    ? 'running'
    : value === 'failed'
      ? 'failed'
      : value === 'killed'
        ? 'stopped'
        : 'completed'

// bash、pwsh 是 shell 工具起的命令，pty-* 是实验性的终端工具；workflow 是工作流
function kind(value: unknown): BackgroundTaskKind | null {
  const name = String(value ?? '')
  if (/agent/i.test(name)) return null
  if (name === 'bash' || name === 'pwsh' || name.startsWith('pty')) return 'shell'
  if (name === 'workflow') return 'workflow'
  return 'other'
}

export class JobRoster {
  private readonly tasks = new Map<string, LitchBackgroundTask>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** job/list 的一帧。返回集合有没有变 */
  rows(jobs: unknown, sessionId: string): boolean {
    if (!Array.isArray(jobs)) return false
    const before = JSON.stringify(this.list())
    const seen = new Set<string>()
    for (const job of jobs) {
      if (!job || typeof job !== 'object' || typeof job.id !== 'string') continue
      if (job.owner !== sessionId) continue
      const taskKind = kind(job.kind)
      if (!taskKind) continue
      seen.add(job.id)
      const taskStatus = status(job.status)
      const startedAt = typeof job.startedAt === 'number' ? job.startedAt : this.now()
      const endedAt =
        taskStatus === 'running'
          ? undefined
          : typeof job.finishedAt === 'number'
            ? job.finishedAt
            : (this.tasks.get(job.id)?.endedAt ?? this.now())
      this.tasks.set(job.id, {
        id: job.id,
        kind: taskKind,
        title: typeof job.label === 'string' ? job.label : String(job.kind ?? ''),
        status: taskStatus,
        startedAt,
        ...(endedAt !== undefined ? { endedAt } : {}),
      })
    }
    for (const task of this.tasks.values())
      if (task.status === 'running' && !seen.has(task.id)) {
        task.status = 'stopped'
        task.endedAt = this.now()
      }
    const ordered = orderBackgroundTasks(this.tasks.values())
    if (ordered.length < this.tasks.size) {
      const kept = new Set(ordered.map((task) => task.id))
      for (const id of this.tasks.keys()) if (!kept.has(id)) this.tasks.delete(id)
    }
    return JSON.stringify(ordered) !== before
  }

  /** 跟随断了（dsh 退出、连接断了）：还在跑的不知道下落，记 stopped。返回集合有没有变 */
  closeAll(): boolean {
    let changed = false
    for (const task of this.tasks.values())
      if (task.status === 'running') {
        task.status = 'stopped'
        task.endedAt = this.now()
        changed = true
      }
    return changed
  }

  list(): LitchBackgroundTask[] {
    return orderBackgroundTasks(this.tasks.values())
  }
}
