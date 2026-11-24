// 限时授权：按“会话 + 类别（MCP 再加服务名）”记在设备库里，按绝对到期时间判定，设备重启后仍在。
// 原生审批（命令、改文件、追加权限、审批性质的 MCP 征询）由设备在收到请求时直接代答，不再转给客户端；
// 客户端工具（操作本机、浏览器、Chrome）由执行它的桌面端拿名单自己判定。
// 授予、撤销只走客户端请求（用户操作），不给模型任何对应工具。约定见 protocol/extensions/timed-approvals.json。
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  findTimedApproval,
  isTimedApprovalCategory,
  nativeApprovalTarget,
  TIMED_APPROVAL,
  TIMED_APPROVAL_SCOPE_MAX,
  TIMED_APPROVALS_EXTENSION,
  TIMED_APPROVALS_MAX,
  type TimedApproval,
  type TimedApprovalCategory,
  validTimedApprovalHours,
} from '../../protocol/src/timed-approvals.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import { isObject } from './wire.mjs'

const HOUR_MS = 3_600_000
/** setTimeout 能等的最长时间，再远的分段等 */
const MAX_TIMER_MS = 2 ** 31 - 1

export interface TimedApprovalsClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const REAL_CLOCK: TimedApprovalsClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

export type TimedApprovalsAnnounce = (method: string, params: unknown, extension: string) => void

export class TimedApprovals {
  private readonly db: DatabaseSync
  private readonly announce: TimedApprovalsAnnounce
  private readonly clock: TimedApprovalsClock
  private grants: TimedApproval[] = []
  private timer: unknown = null
  private closed = false
  /** 新授予了一条：设备把这个会话里同类还在等的原生请求一并代答 */
  onGranted: (grant: TimedApproval) => void = () => {}

  constructor(
    db: DatabaseSync,
    announce: TimedApprovalsAnnounce,
    clock: TimedApprovalsClock = REAL_CLOCK,
  ) {
    this.db = db
    this.announce = announce
    this.clock = clock
    db.exec(`CREATE TABLE IF NOT EXISTS timed_approval_grants(
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, category TEXT NOT NULL,
      scope TEXT NOT NULL, granted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      UNIQUE(thread_id, category, scope)
    )`)
    // 已经到期的不再加载，顺手从库里删掉
    db.prepare('DELETE FROM timed_approval_grants WHERE expires_at<=?').run(this.clock.now())
    this.grants = db
      .prepare('SELECT * FROM timed_approval_grants ORDER BY expires_at')
      .all()
      .flatMap((row): TimedApproval[] => {
        const category = String(row.category)
        if (!isTimedApprovalCategory(category)) return []
        return [
          {
            id: String(row.id),
            threadId: String(row.thread_id),
            category,
            scope: String(row.scope),
            grantedAt: Number(row.granted_at),
            expiresAt: Number(row.expires_at),
          },
        ]
      })
    this.schedule()
  }

  close(): void {
    this.closed = true
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
  }

  /** 此刻生效的全部授权，按到期先后 */
  list(): TimedApproval[] {
    const now = this.clock.now()
    return this.grants.filter((grant) => grant.expiresAt > now)
  }

  /** 这个会话、这一类（这个范围）此刻有没有生效的授权 */
  active(threadId: string, category: TimedApprovalCategory, scope = ''): TimedApproval | null {
    return findTimedApproval(this.grants, threadId, category, this.clock.now(), scope)
  }

  grant(
    threadId: string,
    category: TimedApprovalCategory,
    hours: number,
    scope = '',
  ): TimedApproval {
    const now = this.clock.now()
    const grant: TimedApproval = {
      id: randomUUID(),
      threadId,
      category,
      scope,
      grantedAt: now,
      expiresAt: now + Math.round(hours * HOUR_MS),
    }
    // 同一会话同一类同一范围只留一条：再授予就是按新的时长重算
    this.db
      .prepare(`INSERT INTO timed_approval_grants(id,thread_id,category,scope,granted_at,expires_at)
        VALUES(?,?,?,?,?,?)
        ON CONFLICT(thread_id,category,scope) DO UPDATE SET id=excluded.id,
          granted_at=excluded.granted_at, expires_at=excluded.expires_at`)
      .run(grant.id, threadId, category, scope, grant.grantedAt, grant.expiresAt)
    this.grants = this.grants.filter(
      (entry) =>
        !(entry.threadId === threadId && entry.category === category && entry.scope === scope),
    )
    this.grants.push(grant)
    this.grants.sort((a, b) => a.expiresAt - b.expiresAt)
    // 超出上限时最早到期的让位
    while (this.grants.length > TIMED_APPROVALS_MAX) {
      const dropped = this.grants.shift()
      if (!dropped) break
      this.db.prepare('DELETE FROM timed_approval_grants WHERE id=?').run(dropped.id)
    }
    this.changed()
    this.onGranted(grant)
    return grant
  }

  /** 撤销：按 id 撤一条，或按会话（可加类别）撤一批。返回撤了几条 */
  revoke(match: { id?: string; threadId?: string; category?: TimedApprovalCategory }): number {
    const hit = (grant: TimedApproval) =>
      match.id !== undefined
        ? grant.id === match.id
        : grant.threadId === match.threadId &&
          (match.category === undefined || grant.category === match.category)
    const gone = this.grants.filter(hit)
    if (!gone.length) return 0
    for (const grant of gone)
      this.db.prepare('DELETE FROM timed_approval_grants WHERE id=?').run(grant.id)
    this.grants = this.grants.filter((grant) => !hit(grant))
    this.changed()
    return gone.length
  }

  /** 会话删掉了：它的授权一并删除（不再有人能用到） */
  threadDeleted(threadId: string): void {
    this.revoke({ threadId })
  }

  /** litch/timedApproval/* 客户端请求 */
  call(method: string, value: unknown): unknown {
    const params = isObject(value) ? value : {}
    if (method === TIMED_APPROVAL.list) return { grants: this.list() }
    if (method === TIMED_APPROVAL.grant) {
      if (typeof params.threadId !== 'string' || !params.threadId || params.threadId.length > 4096)
        throw new ProtocolError(-32602, '需要 threadId 字符串')
      if (!isTimedApprovalCategory(params.category))
        throw new ProtocolError(-32602, '未知的授权类别')
      if (!validTimedApprovalHours(params.hours)) throw new ProtocolError(-32602, '时长超出范围')
      // MCP 按服务名分，必须给；其余类别不分范围
      const scope = params.scope
      if (params.category === 'mcp') {
        if (typeof scope !== 'string' || !scope || scope.length > TIMED_APPROVAL_SCOPE_MAX)
          throw new ProtocolError(-32602, 'MCP 授权需要服务名 scope')
        return this.grant(params.threadId, params.category, params.hours, scope)
      }
      if (scope !== undefined && scope !== '') throw new ProtocolError(-32602, '这一类授权不分范围')
      return this.grant(params.threadId, params.category, params.hours)
    }
    if (method === TIMED_APPROVAL.revoke) {
      if (typeof params.id === 'string' && params.id)
        return { revoked: this.revoke({ id: params.id }) }
      if (typeof params.threadId !== 'string' || !params.threadId)
        throw new ProtocolError(-32602, '需要 id 或 threadId')
      if (params.category !== undefined && !isTimedApprovalCategory(params.category))
        throw new ProtocolError(-32602, '未知的授权类别')
      return {
        revoked: this.revoke({
          threadId: params.threadId,
          ...(params.category ? { category: params.category } : {}),
        }),
      }
    }
    throw new ProtocolError(-32601, '未知限时授权方法')
  }

  /**
   * 原生审批请求在授权内时给出代答的结果，否则 null。
   * 列了决定列表却没有“允许”的不代答（引擎本来就不让这一次被直接允许）。
   */
  answer(method: string, params: unknown): unknown | null {
    const target = nativeApprovalTarget(method, params)
    if (!target || !isObject(params) || typeof params.threadId !== 'string') return null
    const { category, scope } = target
    if (!this.active(params.threadId, category, scope)) return null
    // MCP：只答这一次允许，不带“记住”（_meta 里的 persist），授权到期后照常再问
    if (category === 'mcp') return { action: 'accept', content: {}, _meta: null }
    if (category === 'permissions') {
      const requested = isObject(params.permissions) ? params.permissions : {}
      return {
        permissions: {
          ...(requested.network ? { network: requested.network } : {}),
          ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
        },
        scope: 'turn',
      }
    }
    const listed = params.availableDecisions
    if (Array.isArray(listed) && listed.length > 0 && !listed.includes('accept')) return null
    return { decision: 'accept' }
  }

  private changed(): void {
    this.announce(TIMED_APPROVAL.changed, { grants: this.list() }, TIMED_APPROVALS_EXTENSION)
    this.schedule()
  }

  /** 到下一条到期时清掉并通知一次，客户端的名单和界面随之更新 */
  private schedule(): void {
    if (this.closed) return
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
    const next = this.grants[0]
    if (!next) return
    const wait = Math.max(0, next.expiresAt - this.clock.now())
    this.timer = this.clock.setTimeout(
      () => {
        this.timer = null
        const now = this.clock.now()
        const expired = this.grants.filter((grant) => grant.expiresAt <= now)
        if (!expired.length) return this.schedule()
        for (const grant of expired)
          this.db.prepare('DELETE FROM timed_approval_grants WHERE id=?').run(grant.id)
        this.grants = this.grants.filter((grant) => grant.expiresAt > now)
        this.changed()
      },
      Math.min(wait, MAX_TIMER_MS),
    )
  }
}
