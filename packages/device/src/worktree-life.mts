// 工作树跟着会话走（worktrees.mts 管建删，这里管什么时候删、什么时候建回来）：
// - 主人会话归档：还有没归档的会话共用着它，主人转给那一个；没有的话干净的删目录（分支留着），有改动的原样留着（kept）。
// - 取消归档、重新打开（thread/resume）：留着的接着用；删了的先把目录建回原路径（有快照从快照），再交给引擎，
//   Claude、Pi 这些按目录存历史的 harness 恢复会话要那个目录在。共用着它的会话重新打开时也建回来，主人换成它。
// - 删会话：还有共用着的会话就转给它（它归档了的照归档处理）；没有的目录直接删、不留快照，分支留着。
// - 清理（定时、建了新的、归档之后各扫一遍）：留着超过 keptDays 天的存快照再删；开着自动清理时活着的超过 keepCount 个，
//   回收主人已归档的，按主人最后活动从旧到新，有改动的存快照再删。没归档的会话的工作树不回收：设备进程自己发的回合
//  （回报唤醒父会话、定时任务、会话间消息）不经过重新打开，目录没了就跑不起来，所以保留个数是个软上限。
//   置顶的、正在跑的、一小时内建的、被加成工作区根的不动。
// 删、留、建回都在 worktrees.mts 的队里重读记录再判一次：算候选和真动手之间状况可能变了。
import type { Worktree } from '../../protocol/src/worktrees.mjs'
import { inside, type Worktrees } from './worktrees.mjs'

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

  /** 起来时先对账（上次建到一半、没用上的删掉），再扫一遍，之后每小时扫一遍 */
  start(): void {
    this.timer ??= setInterval(() => void this.sweep(), SWEEP_MS)
    this.timer.unref?.()
    void this.worktrees.reconcile().then(() => this.sweep())
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 会话是主人的、或者共用着的工作树 */
  private of(threadId: string): Worktree | null {
    return this.worktrees.forThread(threadId) ?? this.worktrees.sharedBy(threadId)
  }

  /** 重新打开之前要不要先收拾：目录删了、留着没用、删到一半 */
  waiting(threadId: string): boolean {
    const worktree = this.of(threadId)
    return (
      worktree !== null &&
      (worktree.state === 'removed' || worktree.state === 'kept' || worktree.snapshotRef !== null)
    )
  }

  /** 除了 threadId 之外还在用这棵的会话：没归档的优先，archived 为真时归档了的也算（删掉的不算） */
  private heir(worktree: Worktree, threadId: string, archived = false): string | null {
    const others = this.worktrees.sharers(worktree.id).filter((one) => one !== threadId)
    return (
      others.find((one) => this.host.known(one)?.archived === false) ??
      (archived ? (others.find((one) => this.host.known(one) !== null) ?? null) : null)
    )
  }

  /** 会话归档了：是主人的照上面的规矩处理，共用着的不用管 */
  async archived(threadId: string): Promise<void> {
    const worktree = this.worktrees.forThread(threadId)
    if (!worktree || worktree.state === 'removed') return
    const heir = this.heir(worktree, threadId)
    if (heir) {
      this.worktrees.transfer(worktree.id, heir)
      this.host.log(`会话 ${threadId} 归档了，工作树 ${worktree.id} 转给共用着它的 ${heir}`)
      return
    }
    try {
      await this.worktrees.retire(
        worktree.id,
        (current) => current.ownerThreadId === threadId && this.heir(current, threadId) === null,
      )
    } catch (error) {
      this.host.log(`会话 ${threadId} 归档后处理工作树 ${worktree.id} 没成：${messageOf(error)}`)
    }
    void this.sweep()
  }

  /**
   * 会话又要用了（取消归档、重新打开）：留着的接着用，删了的建回原路径。共用着的会话打开时主人不在用了（归档了、删了），
   * 主人换成它。建不回来（分支删了、路径被占）只记日志，会话照样打开（目录不在，引擎会报）
   */
  async reopen(threadId: string): Promise<void> {
    let worktree = this.of(threadId)
    if (!worktree || !this.waiting(threadId)) return
    if (worktree.ownerThreadId !== threadId) {
      const owner = worktree.ownerThreadId ? this.host.known(worktree.ownerThreadId) : null
      if (owner?.archived !== false)
        worktree = this.worktrees.transfer(worktree.id, threadId) ?? worktree
    }
    try {
      if (worktree.state === 'kept' && worktree.snapshotRef === null)
        await this.worktrees.revive(worktree.id)
      else await this.worktrees.restore(worktree.id)
    } catch (error) {
      this.host.log(`会话 ${threadId} 的工作树 ${worktree.id} 建不回来：${messageOf(error)}`)
    }
  }

  /**
   * 会话删了：共用着的不再记；是主人的，还有别的会话在用就转给它（它归档了的照归档处理），
   * 没有的目录直接删、不留快照（分支留着）
   */
  async deleted(threadId: string): Promise<void> {
    this.worktrees.unshare(threadId)
    const worktree = this.worktrees.forThread(threadId)
    if (!worktree || worktree.state === 'removed') return
    const heir = this.heir(worktree, threadId, true)
    if (heir) {
      this.worktrees.transfer(worktree.id, heir)
      this.host.log(`会话 ${threadId} 删了，工作树 ${worktree.id} 转给共用着它的 ${heir}`)
      if (this.host.known(heir)?.archived) await this.archived(heir)
      return
    }
    try {
      await this.worktrees.removeIf(
        worktree.id,
        (current) =>
          current.ownerThreadId === threadId && this.heir(current, threadId, true) === null,
        { discard: true, reason: 'deleted' },
      )
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
    const expired = (one: Worktree) =>
      one.state === 'kept' && one.updatedAt + keptDays * 86400 <= now() && !this.held(one)
    for (const worktree of this.worktrees.list().filter(expired)) {
      const done = await this.removing(worktree, 'kept-expired', expired)
      if (done) this.host.log(`工作树 ${worktree.id} 留了 ${keptDays} 天，存了快照、删了目录`)
    }
    if (!autoCleanup) return
    const live = this.worktrees
      .list()
      .filter((one) => one.state === 'ready' || one.state === 'kept')
    let extra = live.length - keepCount
    if (extra <= 0) return
    for (const worktree of this.candidates(live)) {
      if (extra <= 0) break
      const done = await this.removing(
        worktree,
        'cleanup',
        (current) =>
          (current.state === 'ready' || current.state === 'kept') && this.reclaimable(current),
      )
      if (!done) continue
      this.host.log(`工作树超过 ${keepCount} 个，回收了 ${worktree.id}`)
      extra--
    }
  }

  /** 清理时删一个：在队里再判一次 when；没删（不符了、删不掉）回 false */
  private async removing(
    worktree: Worktree,
    reason: string,
    when: (current: Worktree) => boolean,
  ): Promise<boolean> {
    try {
      return (await this.worktrees.removeIf(worktree.id, when, { reason })) !== null
    } catch (error) {
      this.host.log(`清理工作树 ${worktree.id} 没成：${messageOf(error)}`)
      return false
    }
  }

  /** 不能动的：一小时内建的、被加成工作区根的、主人或共用者置顶了或在跑的 */
  private held(one: Worktree): boolean {
    const users = [
      ...(one.ownerThreadId ? [one.ownerThreadId] : []),
      ...this.worktrees.sharers(one.id),
    ]
    return (
      one.createdAt > now() - FRESH_SECONDS ||
      this.host.roots().some((root) => inside(one.path, root)) ||
      users.some((id) => this.host.pinned(id) || this.host.running(id))
    )
  }

  /** 自动清理能回收的：主人归档了、没有没归档的共用者、不在 held 里 */
  private reclaimable(one: Worktree): boolean {
    const owner = one.ownerThreadId ? this.host.known(one.ownerThreadId) : null
    return (
      owner?.archived === true &&
      this.heir(one, one.ownerThreadId ?? '') === null &&
      !this.held(one)
    )
  }

  /** 能回收的，按主人最后活动从旧到新 */
  private candidates(live: Worktree[]): Worktree[] {
    const last = (one: Worktree) =>
      (one.ownerThreadId ? this.host.known(one.ownerThreadId)?.updatedAt : null) ?? one.updatedAt
    return live.filter((one) => this.reclaimable(one)).sort((a, b) => last(a) - last(b))
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
