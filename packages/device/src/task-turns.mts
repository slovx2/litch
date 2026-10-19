// 认出“这个回合是定时任务发起的”：会话树（session-tree.mts）拿它判断子会话的回合结束时要不要唤醒父会话
// （任务跑出来的回合只进回报、不唤醒）。
//
// 回合结束的通知可能比 turn/start 的应答早到（别的连接上先收到），所以分两步记：
// 发 turn/start 之前先记“这个会话上正要发任务的回合”，应答回来拿到 turnId 再记具体的回合。
// 正要发的那段时间里，这个会话上结束的回合都算任务的（任务已经等会话空下来才发，别的回合混进来的机会很小，
// 认错了的后果也只是少唤醒一次）。记下的回合不随回合结束删，满了丢最早的。

/** 记着的任务回合最多这么多个 */
const TURN_LIMIT = 1_000

export class TaskTurns {
  /** threadId → 正在发的任务回合数 */
  private readonly pending = new Map<string, number>()
  /** `${threadId}\0${turnId}` */
  private readonly turns = new Set<string>()

  /** 要在 threadId 上发任务的回合了。返回的函数在发完（不论成败）时调一次 */
  starting(threadId: string): () => void {
    this.pending.set(threadId, (this.pending.get(threadId) ?? 0) + 1)
    let done = false
    return () => {
      if (done) return
      done = true
      const left = (this.pending.get(threadId) ?? 1) - 1
      if (left > 0) this.pending.set(threadId, left)
      else this.pending.delete(threadId)
    }
  }

  /** 任务的回合开始了（turn/start 的应答到了，或者设备重启后接着看没跑完的回合） */
  started(threadId: string, turnId: string): void {
    if (this.turns.size >= TURN_LIMIT) {
      const oldest = this.turns.values().next().value
      if (oldest !== undefined) this.turns.delete(oldest)
    }
    this.turns.add(`${threadId}\u0000${turnId}`)
  }

  has(threadId: string, turnId: string): boolean {
    return this.pending.has(threadId) || this.turns.has(`${threadId}\u0000${turnId}`)
  }
}
