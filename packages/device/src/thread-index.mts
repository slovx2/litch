// “会话属于哪个 harness”的索引。
// 会话标识看不出属于哪个引擎，所以路由要自己记：从列表结果、新建会话的应答、会话开始的通知里积累。
// 顺带记下会话的近况（更新时间、归没归档、是不是临时的）：设备层的工作区要靠它算最近活动时间。
// 存在设备进程自己的库里（store.mts 的 threads 表），删掉它只是下次要重新向各上游问一遍。
import type { DatabaseSync, StatementSync } from 'node:sqlite'

interface Known {
  harness: string
  updatedAt: number
  archived: boolean
  ephemeral: boolean
}

/** 会话对象上索引要看的那几项 */
export interface SeenThread {
  id: string
  updatedAt?: unknown
  ephemeral?: unknown
  name?: unknown
  cwd?: unknown
}

export class ThreadIndex {
  onChanged: (() => void) | null = null
  private readonly metadata = new Map<string, string>()
  private readonly db: DatabaseSync
  /** 内存里的那一份，和库里的一致 */
  private readonly known = new Map<string, Known>()
  private readonly select: StatementSync
  private readonly upsert: StatementSync
  private readonly remove: StatementSync

  constructor(db: DatabaseSync) {
    this.db = db
    // 临时会话不该活过进程：上一次留下的清掉
    db.exec('DELETE FROM threads WHERE ephemeral=1')
    this.select = db.prepare(
      'SELECT harness, updated_at, archived, ephemeral FROM threads WHERE id=?',
    )
    this.upsert = db.prepare(
      `INSERT INTO threads(id, harness, updated_at, archived, ephemeral, seen_at)
       VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET harness=excluded.harness, updated_at=excluded.updated_at,
         archived=excluded.archived, ephemeral=excluded.ephemeral, seen_at=excluded.seen_at`,
    )
    this.remove = db.prepare('DELETE FROM threads WHERE id=?')
  }

  private load(threadId: string): Known | null {
    const cached = this.known.get(threadId)
    if (cached) return cached
    const row = this.select.get(threadId)
    if (typeof row?.harness !== 'string') return null
    const known = {
      harness: row.harness,
      updatedAt: Number(row.updated_at),
      archived: row.archived === 1,
      ephemeral: row.ephemeral === 1,
    }
    this.known.set(threadId, known)
    return known
  }

  /** 认识的会话的近况（updatedAt 是秒）；不认识是 null */
  recent(threadId: string): { updatedAt: number; archived: boolean } | null {
    const known = this.load(threadId)
    return known ? { updatedAt: known.updatedAt, archived: known.archived } : null
  }

  lookup(threadId: string): string | null {
    return this.load(threadId)?.harness ?? null
  }

  /**
   * 见到了一个会话对象（列表里的一行、应答或通知里的）：记下它属于哪个 harness 和它的近况。
   * 只登记最终标识：调用方给的都是会话对象上的标识，引擎内部用过的临时标识不会走到这里。
   * archived 只有知道的时候才给（列表是按归没归档查的）；不给就保持原来记的。
   */
  see(thread: SeenThread, harness: string, archived?: boolean): void {
    const old = this.load(thread.id)
    if (thread.name !== undefined || thread.cwd !== undefined) {
      const meta = JSON.stringify([thread.name, thread.cwd])
      if (this.metadata.get(thread.id) !== meta) {
        this.metadata.set(thread.id, meta)
        this.onChanged?.()
      }
    }
    const time = Number(thread.updatedAt)
    const next: Known = {
      harness,
      updatedAt: Number.isFinite(time) ? Math.floor(time) : (old?.updatedAt ?? 0),
      archived: archived ?? old?.archived ?? false,
      ephemeral: thread.ephemeral === true,
    }
    if (
      old &&
      old.harness === next.harness &&
      old.updatedAt === next.updatedAt &&
      old.archived === next.archived &&
      old.ephemeral === next.ephemeral
    )
      return
    this.known.set(thread.id, next)
    this.onChanged?.()
    this.upsert.run(
      thread.id,
      next.harness,
      next.updatedAt,
      next.archived ? 1 : 0,
      next.ephemeral ? 1 : 0,
      Date.now(),
    )
  }

  /** 会话被归档或者恢复了。没见过的会话不管 */
  setArchived(threadId: string, archived: boolean): void {
    const old = this.load(threadId)
    if (!old || old.archived === archived) return
    this.see(
      { id: threadId, updatedAt: old.updatedAt, ephemeral: old.ephemeral },
      old.harness,
      archived,
    )
  }

  /** 一次登记很多条（一页列表结果）时包在一个事务里 */
  batch(work: () => void): void {
    this.db.exec('BEGIN')
    try {
      work()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** 记着这个会话归档了 */
  archived(threadId: string): boolean {
    return this.load(threadId)?.archived === true
  }

  /** 一个会话都没记着（库刚建、刚换过） */
  empty(): boolean {
    return this.db.prepare('SELECT 1 FROM threads LIMIT 1').get() === undefined
  }

  forget(threadId: string): void {
    this.known.delete(threadId)
    this.remove.run(threadId)
  }

  /** 丢掉内存里的那一份，之后都从库里重新读。包着登记的事务回滚了的时候用 */
  reset(): void {
    this.known.clear()
  }
}
