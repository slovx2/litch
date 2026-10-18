// 设备级的工作区、会话到工作区的归属、分区与置顶。
// 一台设备上的一个工作区下面并列着各个 harness 的会话，所以归属存在设备层，不存在任何引擎里。
// 对外用的是 Codex 协议里现成的方法：`project/*` 管工作区，`thread/metadata/update` 改归属，
// `threadSection/*`、`thread/section/move` 管分区与置顶。
//
// 工作区这部分直接复用引擎用的那份实现（packages/shared 的 ProjectStore、projectRequest），
// 落在设备进程自己的库里：幂等键、翻页、排序、校验、删工作区只解除归属不删会话，和引擎里逐条一致。
// 那份实现要问会话的情况（存不存在、是不是临时的、最近活动时间），这里给它的是同库的 threads 表（threadsTable），就是索引那张表。
// 下面有两处直接碰它的表：members（某个工作区里有哪些会话，它没有对外提供这个读法）
// 和导入用的 adopt、absorb、link（要沿用引擎里的标识和时间，还要能包在导入的那一个事务里）。
//
// 设备层是这份数据唯一的写入者，变了就告诉所有聚合面连接。
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import {
  EXTENSION,
  THREAD_SECTION_UPDATED,
  THREAD_SECTIONS_CHANGED,
} from '../../protocol/src/device.mjs'
import { projectRequest } from '../../shared/src/project-rpc.mjs'
import {
  type Project,
  type ProjectFields,
  ProjectStore,
  threadsTable,
} from '../../shared/src/project-store.mjs'
import { ProtocolError, requiredString } from '../../shared/src/protocol-contract.mjs'
import { PINNED_SECTION_ID } from '../../shared/src/thread-sections.mjs'
import { SectionStore } from './sections.mjs'
import { isObject } from './wire.mjs'

/** 发给所有聚合面连接。extension 给了就只发给握手时声明过它的 */
export type Announce = (method: string, params: unknown, extension?: string) => void

/** 设备层处理的工作区、分区方法。别的 `project/*`、`threadSection/*` 聚合面不认 */
const METHODS = new Set([
  'project/list',
  'project/read',
  'project/create',
  'project/import',
  'project/update',
  'project/move',
  'project/delete',
  'threadSection/list',
  'threadSection/create',
  'threadSection/update',
  'threadSection/delete',
  'thread/section/move',
])

export function isWorkspaceMethod(method: string): boolean {
  return METHODS.has(method)
}

/** `thread/list` 里由设备层来筛的那几个条件 */
export interface ThreadFilter {
  accept(threadId: string): boolean
  /** 满足条件的只可能是这些会话。null：说不出来（问的是“没有归属的”“不在分区里的”） */
  candidates: string[] | null
}

/** 导入时要建的一个工作区：标识和时间沿用引擎里的 */
export interface AdoptedProject extends ProjectFields {
  id: string
  createdAt: number
  updatedAt: number
}

/**
 * 转给上游的请求里，应答回来时设备层还有事要做的那几种：
 * - born：新建或者分叉出一个会话，它要落进一个工作区（新建时客户端指定的，分叉时跟着原会话的）
 * - gone：删除会话，成了之后它在设备层的归属、分区一起清掉
 * - shelved：归档或者恢复，成了之后记下来（工作区的最近活动时间不算归档了的会话）
 */
export type Expectation =
  | { kind: 'born'; projectId: string }
  | { kind: 'gone'; threadId: string }
  | { kind: 'shelved'; threadId: string; archived: boolean }

export class Workspaces {
  readonly projects: ProjectStore
  readonly sections: SectionStore
  private readonly db: DatabaseSync
  private readonly announce: Announce
  private readonly selectThread: StatementSync
  /** 正在做一批改动时攒着的通知。null：没有在做，通知直接发 */
  private queued: Parameters<Announce>[] | null = null

  constructor(db: DatabaseSync, announce: Announce) {
    this.db = db
    this.announce = announce
    this.projects = new ProjectStore(db, threadsTable(db))
    this.sections = new SectionStore(db)
    this.selectThread = db.prepare('SELECT 1 FROM threads WHERE id=?')
  }

  // ---------- 协议方法 ----------

  /** 处理一个工作区或分区方法。调用方要先确认参数里的会话是设备上真有的（索引里有） */
  call(method: string, params: unknown): unknown {
    const fields = isObject(params) ? params : {}
    if (method.startsWith('project/'))
      return projectRequest(
        this.projects,
        method,
        fields,
        (projectId, changeType) => this.emit('project/changed', { projectId, changeType }),
        (threadId, projectId) => this.emit('thread/project/updated', { threadId, projectId }),
      )
    switch (method) {
      case 'threadSection/list':
        return this.sectionPage(fields)
      case 'threadSection/create': {
        const section = this.sections.create(fields.name, fields.appearance)
        this.sectionsChanged(section.id, 'created')
        return { section }
      }
      case 'threadSection/update': {
        const section = this.sections.update(fields.sectionId, fields.name, fields.appearance)
        this.sectionsChanged(section.id, 'updated')
        // 里面的会话带着的分区对象也跟着变了
        for (const threadId of this.sections.members(section.id)) this.sectionUpdated(threadId)
        return { section }
      }
      case 'threadSection/delete': {
        const members = this.sections.delete(fields.sectionId)
        this.sectionsChanged(String(fields.sectionId), 'deleted')
        for (const threadId of members) this.sectionUpdated(threadId)
        return {}
      }
      case 'thread/section/move': {
        const threadId = requiredString(fields.threadId, 'threadId')
        if (fields.sectionId !== null && typeof fields.sectionId !== 'string')
          throw new ProtocolError(-32602, 'sectionId 必须是字符串或 null')
        if (fields.sectionId === '') throw new ProtocolError(-32602, 'sectionId 不能是空字符串')
        // beforeThreadId（插到分区里哪个会话之前）不管：聚合面的会话列表只有按更新时间一种排序，
        // 分区里的手动顺序没有地方读，所以也不存。各引擎里 Claude 存了这个顺序，Pi 没有
        this.place(threadId, fields.sectionId)
        return {}
      }
      default:
        throw new ProtocolError(-32601, `设备层没有这个方法：${method}`)
    }
  }

  /** 分区列表：翻页的写法照 Claude 引擎的（游标是偏移量，页大小在 1 到 200 之间取） */
  private sectionPage(fields: Record<string, unknown>): unknown {
    const requested = typeof fields.limit === 'number' ? fields.limit : 100
    const limit = Number.isFinite(requested)
      ? Math.max(1, Math.min(Math.floor(requested), 200))
      : 100
    const offset = typeof fields.cursor === 'string' ? Number(fields.cursor) : 0
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ProtocolError(-32602, '分区游标无效')
    const all = this.sections.list()
    const data = all.slice(offset, offset + limit)
    const end = offset + data.length
    return { data, nextCursor: end < all.length ? String(end) : null }
  }

  // ---------- 归属 ----------

  projectOf(threadId: string): string | null {
    return this.projects.projectId(threadId)
  }

  // ---------- 通知 ----------

  /** 发一条通知。正在做一批改动（atomically）的时候先攒着 */
  private emit(method: string, params: unknown, extension?: string): void {
    if (this.queued) this.queued.push([method, params, extension])
    else this.announce(method, params, extension)
  }

  /**
   * 一批改动包在一个事务里做（导入时用）：都成了才把这期间的通知发出去；
   * 中途出错就整个不算，库里不留半截，通知也一条不发。
   */
  atomically<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    this.queued = []
    let queued: Parameters<Announce>[]
    let result: T
    try {
      result = work()
      this.db.exec('COMMIT')
      queued = this.queued
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.queued = null
    }
    for (const [method, params, extension] of queued) this.announce(method, params, extension)
    return result
  }

  /** 工作区在不在。不在就抛“未知项目” */
  requireProject(projectId: string): void {
    this.projects.read(projectId)
  }

  /** 改一个会话的归属（null 是解除）。真的变了才通知，返回变了没有 */
  assign(threadId: string, projectId: string | null): boolean {
    if (!this.projects.assignThread(threadId, projectId)) return false
    this.emit('thread/project/updated', { threadId, projectId })
    return true
  }

  /**
   * 新建（或分叉出来）的会话落进一个工作区。等上游应答的工夫里工作区被删了的话就不归了。
   * 引擎里不为出生时带着的归属发通知，这里要发：别的连接各自从引擎收到的会话开始通知
   * 可能比这里记下归属来得早，那一条上的工作区还是空的，靠这条补上。
   */
  adoptThread(threadId: string, projectId: string): boolean {
    try {
      return this.assign(threadId, projectId)
    } catch {
      return false
    }
  }

  // ---------- 分区与置顶 ----------

  private requireThread(threadId: string): void {
    if (!this.selectThread.get(threadId)) throw new ProtocolError(-32602, '未知会话')
  }

  /** 把会话放进一个分区，或者（null）拿出来。真的变了才通知 */
  place(threadId: string, sectionId: string | null): boolean {
    this.requireThread(threadId)
    if (!this.sections.place(threadId, sectionId)) return false
    this.sectionUpdated(threadId)
    return true
  }

  /** `thread/metadata/update` 里的 isPinned：和现在的置顶状态不一样才动，在别的分区里的取消置顶不动它 */
  pin(threadId: string, pinned: boolean): boolean {
    const current = this.sections.placement(threadId)?.section.id === PINNED_SECTION_ID
    return current === pinned ? false : this.place(threadId, pinned ? PINNED_SECTION_ID : null)
  }

  private sectionUpdated(threadId: string): void {
    const placement = this.sections.placement(threadId)
    this.emit(
      THREAD_SECTION_UPDATED,
      {
        threadId,
        section: placement?.section ?? null,
        sectionEnteredAt: placement?.enteredAt ?? null,
        isPinned: placement?.section.id === PINNED_SECTION_ID,
      },
      EXTENSION.deviceWorkspaces,
    )
  }

  private sectionsChanged(sectionId: string, changeType: 'created' | 'updated' | 'deleted'): void {
    this.emit(THREAD_SECTIONS_CHANGED, { sectionId, changeType }, EXTENSION.deviceWorkspaces)
  }

  // ---------- 请求和会话对象经过聚合面时 ----------

  /**
   * 一个要转给上游的请求：应答回来时设备层要做什么，哪些参数不带给上游。
   * 新建会话带的工作区是设备层的，引擎不认识这个标识（它有自己那一份），所以摘下来，
   * 等上游把会话建好再记进设备层。
   */
  outgoing(
    method: string,
    fields: Record<string, unknown>,
  ): { expectation: Expectation | null; withhold: string[] } {
    const threadId = typeof fields.threadId === 'string' ? fields.threadId : null
    if (method === 'thread/start') {
      if (fields.projectId == null) return { expectation: null, withhold: ['projectId'] }
      const projectId = requiredString(fields.projectId, 'projectId')
      this.requireProject(projectId)
      return { expectation: { kind: 'born', projectId }, withhold: ['projectId'] }
    }
    if (threadId === null) return { expectation: null, withhold: [] }
    if (method === 'thread/fork') {
      // 分叉出来的会话跟着原会话待在同一个工作区里，和引擎里的做法一样
      const projectId = this.projectOf(threadId)
      return { expectation: projectId === null ? null : { kind: 'born', projectId }, withhold: [] }
    }
    if (method === 'thread/delete') return { expectation: { kind: 'gone', threadId }, withhold: [] }
    if (method === 'thread/archive' || method === 'thread/unarchive')
      return {
        expectation: { kind: 'shelved', threadId, archived: method === 'thread/archive' },
        withhold: [],
      }
    return { expectation: null, withhold: [] }
  }

  /**
   * 把会话对象上的工作区、分区、置顶换成设备层的值。引擎自己那一份（官方桌面端在它的入口上用的）
   * 和这里互不相通，不能带到聚合面上来。
   */
  decorate(threadId: string, thread: Record<string, unknown>): void {
    const placement = this.sections.placement(threadId)
    thread.projectId = this.projectOf(threadId)
    thread.section = placement?.section ?? null
    thread.sectionEnteredAt = placement?.enteredAt ?? null
    // 这两项不是协议里的字段，是适配器的引擎多给的：对面给了才换，没给（原生 codex）不添
    if ('isPinned' in thread) thread.isPinned = placement?.section.id === PINNED_SECTION_ID
    if ('sectionId' in thread) thread.sectionId = placement?.section.id ?? null
  }

  /** 会话没了（被删了）：它的归属、分区一起清掉。要在索引忘掉它之前调用 */
  forget(threadId: string): void {
    if (!this.selectThread.get(threadId)) return
    this.projects.assignThread(threadId, null)
    this.sections.place(threadId, null)
  }

  // ---------- 会话列表的筛选 ----------

  private members(projectId: string): string[] {
    return this.db
      .prepare(
        `SELECT thread_id FROM project_threads WHERE project_id=?
         UNION SELECT thread_id FROM live_project_threads WHERE project_id=?`,
      )
      .all(projectId, projectId)
      .map((row) => String(row.thread_id))
  }

  /**
   * `thread/list` 的 projectId、sectionId、isPinned：归属在设备层，所以由设备层来筛，不交给上游。
   * 写法照引擎：不带是全部，null 是“没有归属的”“不在分区里的”，字符串是指定的那一个。
   * 没带这几个条件时返回 null。
   */
  filter(fields: Record<string, unknown>): ThreadFilter | null {
    const tests: ((threadId: string) => boolean)[] = []
    let candidates: string[] | null = null
    if (fields.projectId !== undefined) {
      const projectId =
        fields.projectId === null ? null : requiredString(fields.projectId, 'projectId')
      tests.push((threadId) => this.projectOf(threadId) === projectId)
      if (projectId !== null) candidates = this.members(projectId)
    }
    if (fields.sectionId === null || typeof fields.sectionId === 'string') {
      const sectionId = fields.sectionId
      tests.push(
        (threadId) => (this.sections.placement(threadId)?.section.id ?? null) === sectionId,
      )
      if (sectionId !== null) candidates ??= this.sections.members(sectionId)
    }
    if (typeof fields.isPinned === 'boolean') {
      const pinned = fields.isPinned
      tests.push(
        (threadId) =>
          (this.sections.placement(threadId)?.section.id === PINNED_SECTION_ID) === pinned,
      )
      if (pinned) candidates ??= this.sections.members(PINNED_SECTION_ID)
    }
    if (tests.length === 0) return null
    return { accept: (threadId) => tests.every((test) => test(threadId)), candidates }
  }

  // ---------- 导入时用的写法（workspace-import.mts，调用方包在一个事务里） ----------

  /** 建一个工作区，标识和时间照给的来（沿用引擎里的），排在现有的后面 */
  adopt(project: AdoptedProject): void {
    const position = Number(
      this.db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS value FROM projects').get()?.value,
    )
    this.db
      .prepare(
        `INSERT INTO projects(id,idempotency_key,name,roots_json,metadata_json,position,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        project.id,
        `litch-import:${project.id}`,
        project.name,
        JSON.stringify(project.roots),
        JSON.stringify(project.metadata),
        position,
        project.createdAt,
        project.updatedAt,
      )
    this.emit('project/changed', { projectId: project.id, changeType: 'created' })
  }

  /** 别的引擎里根目录相同的项目并进一个已有的工作区：只动元数据和更新时间 */
  absorb(project: Project, metadata: Record<string, string>, updatedAt: number): void {
    this.db
      .prepare('UPDATE projects SET metadata_json=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(metadata), Math.max(project.updatedAt, updatedAt), project.id)
    this.emit('project/changed', { projectId: project.id, changeType: 'updated' })
  }

  /** 导入来的归属：只补不盖，会话在设备层已经有归属的不动。返回补上了没有 */
  link(threadId: string, projectId: string): boolean {
    if (this.projectOf(threadId) !== null) return false
    this.db
      .prepare('INSERT INTO project_threads(thread_id, project_id) VALUES(?,?)')
      .run(threadId, projectId)
    this.emit('thread/project/updated', { threadId, projectId })
    return true
  }

  /** 导入来的分区位置：只补不盖。进分区的时间照引擎里记的 */
  settle(threadId: string, sectionId: string, enteredAt: number): boolean {
    if (this.sections.placement(threadId)) return false
    this.sections.place(threadId, sectionId, enteredAt)
    this.sectionUpdated(threadId)
    return true
  }

  /** 导入来的分区，标识沿用引擎里的 */
  adoptSection(id: string, name: string, appearance: unknown, createdAt: number): void {
    this.sections.create(name, appearance, id, createdAt)
    this.sectionsChanged(id, 'created')
  }
}
