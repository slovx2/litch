// 工作树跟着会话走（worktrees.mts 管建删，这里管什么时候删、什么时候建回来）：
// - 主人会话归档：还有没归档的会话共用着它，主人转给那一个；没有的话干净的删目录（分支留着），有改动的原样留着（kept）。
// - 取消归档、重新打开（thread/resume）：留着的接着用；删了的先把目录建回原路径（有快照从快照），再交给引擎，
//   Claude、Pi 这些按目录存历史的 harness 恢复会话要那个目录在。
// - 删会话：目录直接删、不留快照，分支留着。
// - 清理（定时、建了新的、归档之后各扫一遍）：留着超过 keptDays 天的存快照再删；开着自动清理时活着的超过 keepCount 个，
//   先回收主人已归档、已不存在的，再按主人最后活动从旧到新，有改动的存快照再删。置顶的、正在跑的、一小时内建的、
//   被加成工作区根的不动。
import type { Worktree } from '../../protocol/src/worktrees.mjs'
import type { Worktrees } from './worktrees.mjs'

export interface WorktreeLifeHost {
  /** 索引里知道的会话近况；不认识（删了、从没见过）是 null。updatedAt 是秒 */
  known(threadId: string): { updatedAt: number; archived: boolean } | null
  pinned(threadId: string): boolean
  /** 有回合在跑 */
  running(threadId: string): boolean
  /** 设备级工作区的根目录 */
  roots(): string[]
  log(line: string): void
}

/** 一小时内建的不清理 */
const FRESH_SECONDS = 3600

/** 隔多久扫一遍（毫秒） */
const SWEEP_MS = 60 * 60 * 1000

const now = () => Math.floor(Date.now() / 1000)

export class WorktreeLife {
  private readonly worktrees: Worktrees
  private readonly host: WorktreeLifeHost
  private timer: ReturnType<typeof setInterval> | null = null
  /** 正在扫：扫的时候又要扫的，等这一遍完了再来一遍 */
  private sweeping: Promise<void> | null = null
  private again = false

  constructor(worktrees: Worktrees, host: WorktreeLifeHost) {
    this.worktrees = worktrees
    this.host = host
  }

  start(): void {
    this.timer ??= setInterval(() => void this.sweep(), SWEEP_MS)
    this.timer.unref?.()
    void this.sweep()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 重新打开之前要不要先收拾：会话是工作树的主人，目录删了或者留着没用 */
  waiting(threadId: string): boolean {
    const state = this.worktrees.forThread(threadId)?.state
    return state === 'removed' || state === 'kept'
  }

  /** 会话归档了：是主人的照上面的规矩处理，共用着的不用管 */
  async archived(threadId: string): Promise<void> {
    const worktree = this.worktrees.forThread(threadId)
    if (!worktree || worktree.state === 'removed') return
    const heir = this.worktrees
      .sharers(worktree.id)
      .find((one) => one !== threadId && this.host.known(one)?.archived === false)
    if (heir) {
      this.worktrees.transfer(worktree.id, heir)
      this.host.log(`会话 ${threadId} 归档了，工作树 ${worktree.id} 转给共用着它的 ${heir}`)
      return
    }
    if (worktree.state !== 'ready') return
    try {
      if (await this.worktrees.isDirty(worktree.id)) this.worktrees.keep(worktree.id)
      else await this.worktrees.remove(worktree.id, { reason: 'archived' })
    } catch (error) {
      this.host.log(`会话 ${threadId} 归档后处理工作树 ${worktree.id} 没成：${messageOf(error)}`)
    }
    void this.sweep()
  }

  /**
   * 会话又要用了（取消归档、重新打开）：留着的接着用，删了的建回原路径。建不回来（分支删了、路径被占）只记日志，
   * 会话照样打开（目录不在，引擎会报）
   */
  async reopen(threadId: string): Promise<void> {
    const worktree = this.worktrees.forThread(threadId)
    if (!worktree) return
    if (worktree.state === 'kept') {
      this.worktrees.revive(worktree.id)
      return
    }
    if (worktree.state !== 'removed') return
    try {
      await this.worktrees.restore(worktree.id)
    } catch (error) {
      this.host.log(`会话 ${threadId} 的工作树 ${worktree.id} 建不回来：${messageOf(error)}`)
    }
  }

  /** 会话删了：是主人的，目录直接删、不留快照（分支留着）；共用着的不再记 */
  async deleted(threadId: string): Promise<void> {
    this.worktrees.unshare(threadId)
    const worktree = this.worktrees.forThread(threadId)
    if (!worktree || worktree.state === 'removed') return
    try {
      await this.worktrees.remove(worktree.id, { discard: true, reason: 'deleted' })
    } catch (error) {
      this.host.log(`会话 ${threadId} 删了，工作树 ${worktree.id} 没删掉：${messageOf(error)}`)
    }
  }

  /** 扫一遍（见文件开头）。同时只扫一遍 */
  sweep(): Promise<void> {
    if (this.sweeping) {
      this.again = true
      return this.sweeping
    }
    this.sweeping = this.sweepOnce()
      .catch((error: unknown) => this.host.log(`清理工作树没成：${messageOf(error)}`))
      .finally(() => {
        this.sweeping = null
        if (this.again) {
          this.again = false
          void this.sweep()
        }
      })
    return this.sweeping
  }

  private async sweepOnce(): Promise<void> {
    const { autoCleanup, keepCount, keptDays } = this.worktrees.settings()
    const at = now()
    for (const worktree of this.worktrees.list()) {
      if (worktree.state !== 'kept' || worktree.updatedAt + keptDays * 86400 > at) continue
      await this.worktrees.remove(worktree.id, { reason: 'kept-expired' })
      this.host.log(`工作树 ${worktree.id} 留了 ${keptDays} 天，存了快照、删了目录`)
    }
    if (!autoCleanup) return
    const live = this.worktrees
      .list()
      .filter((one) => one.state === 'ready' || one.state === 'kept')
    let extra = live.length - keepCount
    if (extra <= 0) return
    for (const worktree of this.candidates(live, at)) {
      if (extra <= 0) break
      await this.worktrees.remove(worktree.id, { reason: 'cleanup' })
      this.host.log(`工作树超过 ${keepCount} 个，回收了 ${worktree.id}`)
      extra--
    }
  }

  /** 能回收的，先回收的在前：主人归档了、不在了的，再按主人最后活动从旧到新 */
  private candidates(live: Worktree[], at: number): Worktree[] {
    const roots = this.host.roots()
    const users = (one: Worktree) => [
      ...(one.ownerThreadId ? [one.ownerThreadId] : []),
      ...this.worktrees.sharers(one.id),
    ]
    const kept = (one: Worktree) =>
      one.createdAt > at - FRESH_SECONDS ||
      roots.some((root) => root === one.path || root.startsWith(`${one.path}/`)) ||
      users(one).some((id) => this.host.pinned(id) || this.host.running(id))
    const rank = (one: Worktree): [number, number] => {
      const owner = one.ownerThreadId ? this.host.known(one.ownerThreadId) : null
      return owner && !owner.archived ? [1, owner.updatedAt] : [0, one.updatedAt]
    }
    return live
      .filter((one) => !kept(one))
      .map((one) => ({ one, rank: rank(one) }))
      .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1])
      .map(({ one }) => one)
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
