import type { DatabaseSync } from 'node:sqlite'
import { ProtocolError } from './protocol-contract.mjs'
import { newId, nowSeconds } from './util.mjs'

export type ProjectFields = {
  name: string
  roots: Array<{ path: string }>
  metadata: Record<string, string>
}
export type Project = ProjectFields & {
  id: string
  position: number
  createdAt: number
  updatedAt: number
  recencyAt: number | null
}

/**
 * 项目存储要向入口问的两件会话的事。会话存在哪由各入口自己定：Claude Code、Pi 和设备进程是
 * 同一个库里的 `threads` 表（见 threadsTable），dsh 的会话在 dsh 自己手里。项目存储不直接查哪张表。
 */
export interface ProjectThreads {
  /** 这个会话在不在；在的话是不是临时会话。不在返回 null */
  find(threadId: string): { ephemeral: boolean } | null
  /** 这些会话里没归档、也不是临时的那些，最近一次更新的时间（秒）；一个都没有返回 null */
  recency(threadIds: string[]): number | null
}

/** 会话就在同一个库的 `threads` 表里：列要有 id、updated_at、archived、ephemeral */
export function threadsTable(db: DatabaseSync): ProjectThreads {
  return {
    find(threadId) {
      const row = db.prepare('SELECT ephemeral FROM threads WHERE id=?').get(threadId)
      return row ? { ephemeral: row.ephemeral === 1 } : null
    },
    recency(threadIds) {
      const row = db
        .prepare(`
        SELECT MAX(updated_at) AS value FROM threads
        WHERE archived=0 AND ephemeral=0 AND id IN (SELECT value FROM json_each(?))
      `)
        .get(JSON.stringify(threadIds))
      return row?.value == null ? null : Number(row.value)
    },
  }
}

export class ProjectStore {
  private readonly db: DatabaseSync
  private readonly threads: ProjectThreads

  constructor(db: DatabaseSync, threads: ProjectThreads) {
    this.db = db
    this.threads = threads
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL, roots_json TEXT NOT NULL, metadata_json TEXT NOT NULL,
        position INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_threads (
        thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_project_members ON project_threads(project_id);
      CREATE TEMP TABLE IF NOT EXISTS live_project_threads (
        thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL
      );
    `)
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  list(): Project[] {
    // 最近活动时间只看落了盘的归属：临时会话的归属在另一张表里，本来也不算。
    const members = new Map<string, string[]>()
    for (const row of this.db.prepare('SELECT project_id, thread_id FROM project_threads').all()) {
      const ids = members.get(String(row.project_id)) ?? []
      ids.push(String(row.thread_id))
      members.set(String(row.project_id), ids)
    }
    return this.db
      .prepare('SELECT * FROM projects ORDER BY position, id')
      .all()
      .map((row) => {
        const ids = members.get(String(row.id))
        return {
          id: String(row.id),
          name: String(row.name),
          roots: JSON.parse(String(row.roots_json)) as Project['roots'],
          metadata: JSON.parse(String(row.metadata_json)) as Project['metadata'],
          position: Number(row.position),
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
          recencyAt: ids ? this.threads.recency(ids) : null,
        }
      })
  }

  read(id: string): Project {
    const project = this.list().find((entry) => entry.id === id)
    if (!project) throw new ProtocolError(-32602, '未知项目')
    return project
  }

  projectId(threadId: string): string | null {
    const row = this.db
      .prepare(`
      SELECT project_id FROM project_threads WHERE thread_id=?
      UNION ALL SELECT project_id FROM live_project_threads WHERE thread_id=?
    `)
      .get(threadId, threadId)
    return row ? String(row.project_id) : null
  }

  private assign(threadId: string, projectId: string | null): boolean {
    const thread = this.threads.find(threadId)
    if (!thread) throw new ProtocolError(-32602, '未知会话')
    if (this.projectId(threadId) === projectId) return false
    // 临时会话归属只存在于当前数据库连接，不能在进程重启后恢复。
    const table = thread.ephemeral ? 'live_project_threads' : 'project_threads'
    if (projectId === null) this.db.prepare(`DELETE FROM ${table} WHERE thread_id=?`).run(threadId)
    else
      this.db
        .prepare(`
      INSERT INTO ${table}(thread_id,project_id) VALUES(?,?)
      ON CONFLICT(thread_id) DO UPDATE SET project_id=excluded.project_id
    `)
        .run(threadId, projectId)
    return true
  }

  assignThread(threadId: string, projectId: string | null): boolean {
    return this.transaction(() => {
      if (projectId !== null) this.read(projectId)
      return this.assign(threadId, projectId)
    })
  }

  create(
    fields: ProjectFields,
    key: string,
    threads: string[],
  ): {
    project: Project
    created: boolean
    assigned: string[]
  } {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM projects WHERE idempotency_key=?').get(key)
      if (existing) return { project: this.read(String(existing.id)), created: false, assigned: [] }
      // 校验全部归属后再写入，非法导入不能留下半个项目或转移部分会话。
      for (const threadId of threads)
        if (!this.threads.find(threadId)) throw new ProtocolError(-32602, '导入包含未知会话')
      const id = newId(),
        now = nowSeconds()
      const position = Number(
        this.db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS value FROM projects').get()?.value,
      )
      this.db
        .prepare(`
        INSERT INTO projects(id,idempotency_key,name,roots_json,metadata_json,position,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)
      `)
        .run(
          id,
          key,
          fields.name,
          JSON.stringify(fields.roots),
          JSON.stringify(fields.metadata),
          position,
          now,
          now,
        )
      const assigned = [...new Set(threads)].filter((threadId) => this.assign(threadId, id))
      return { project: this.read(id), created: true, assigned }
    })
  }

  update(id: string, patch: Partial<ProjectFields>): Project {
    return this.transaction(() => {
      const project = { ...this.read(id), ...patch, updatedAt: nowSeconds() }
      this.db
        .prepare('UPDATE projects SET name=?,roots_json=?,metadata_json=?,updated_at=? WHERE id=?')
        .run(
          project.name,
          JSON.stringify(project.roots),
          JSON.stringify(project.metadata),
          project.updatedAt,
          id,
        )
      return project
    })
  }

  move(id: string, beforeId: string | null): boolean {
    return this.transaction(() => {
      this.read(id)
      if (beforeId !== null) this.read(beforeId)
      if (beforeId === id) return false
      const old = this.list().map((project) => project.id)
      const reordered = old.filter((projectId) => projectId !== id)
      reordered.splice(beforeId === null ? reordered.length : reordered.indexOf(beforeId), 0, id)
      if (old.every((projectId, index) => projectId === reordered[index])) return false
      const update = this.db.prepare('UPDATE projects SET position=?,updated_at=? WHERE id=?')
      for (const [position, projectId] of reordered.entries())
        update.run(position, nowSeconds(), projectId)
      return true
    })
  }

  delete(id: string): string[] {
    return this.transaction(() => {
      this.read(id)
      const threads = this.db
        .prepare(`
        SELECT thread_id FROM project_threads WHERE project_id=?
        UNION SELECT thread_id FROM live_project_threads WHERE project_id=?
      `)
        .all(id, id)
        .map((row) => String(row.thread_id))
      this.db.prepare('DELETE FROM project_threads WHERE project_id=?').run(id)
      this.db.prepare('DELETE FROM live_project_threads WHERE project_id=?').run(id)
      this.db.prepare('DELETE FROM projects WHERE id=?').run(id)
      return threads
    })
  }
}
