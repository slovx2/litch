// 工作线的运行事实来自会话树；这里只缓存读取结果，不把它当作可编辑看板对象。
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { Manager, ManagerLine, SessionManagerMark } from '../../protocol/src/manager.mjs'
import { type ManagerStore, managerNow } from './manager-store.mjs'
import { ManagerError } from './manager-validate.mjs'
import type { SessionTree } from './session-tree.mjs'
import { isObject } from './wire.mjs'

export class ManagerLines {
  readonly snapshots = new Map<string, Record<string, unknown>>()
  private readonly reserved = new Map<string, { managerId: string; threadId: string | null }>()
  private readonly began = new Map<string, number>()
  readonly store: ManagerStore
  readonly tree: SessionTree
  constructor(store: ManagerStore, tree: SessionTree) {
    this.store = store
    this.tree = tree
  }
  mark(threadId: string): SessionManagerMark | null {
    const own = this.store.forThread(threadId)
    if (own) return { managerId: own.id, role: 'manager' }
    for (const manager of this.store.managers())
      if (this.tree.store.descends(threadId, manager.threadId))
        return { managerId: manager.id, role: 'line' }
    return null
  }
  managerFor(threadId: string): Manager | null {
    const mark = this.mark(threadId)
    return mark ? this.store.manager(mark.managerId) : null
  }
  observe(method: string, params: Record<string, unknown>): void {
    if (isObject(params.thread) && typeof params.thread.id === 'string')
      this.snapshots.set(params.thread.id, params.thread)
    if (typeof params.threadId !== 'string') return
    const id = params.threadId
    if (method === 'thread/name/updated' && typeof params.threadName === 'string')
      this.snapshots.set(id, { ...this.snapshots.get(id), name: params.threadName })
    if (method === 'thread/status/changed')
      this.snapshots.set(id, { ...this.snapshots.get(id), status: params.status })
    if (method === 'turn/started') this.began.set(id, managerNow())
    if (method === 'turn/completed') {
      this.began.delete(id)
      const previous = this.snapshots.get(id)
      const turn = isObject(params.turn) ? params.turn : {}
      this.snapshots.set(id, {
        ...previous,
        status: { type: turn.status === 'failed' ? 'systemError' : 'idle' },
      })
    }
  }
  lines(managerId: string): ManagerLine[] {
    return this.tree.store
      .children()
      .filter((child) => this.mark(child.threadId)?.managerId === managerId)
      .map((child) => {
        const thread = this.snapshots.get(child.threadId)
        const state = isObject(thread?.status) ? thread.status.type : thread?.status
        const flags =
          isObject(thread?.status) && Array.isArray(thread.status.activeFlags)
            ? thread.status.activeFlags
            : []
        const waiting = this.tree.pendingRequests(child.threadId).length > 0 || flags.length > 0
        const active = this.tree.isActive(child.threadId) || state === 'active'
        const running = active || waiting || this.tree.host.backgroundRunning(child.threadId) > 0
        const worktree =
          this.tree.host.worktrees?.forThread(child.threadId) ??
          (typeof thread?.cwd === 'string'
            ? this.tree.host.worktrees?.containing(thread.cwd)
            : null)
        const report = this.store.report(child.threadId)
        const startedAt = running ? (this.began.get(child.threadId) ?? null) : null
        return {
          threadId: child.threadId,
          parentThreadId: child.parentThreadId,
          title: typeof thread?.name === 'string' && thread.name ? thread.name : child.title,
          harness: child.harness,
          cwd: typeof thread?.cwd === 'string' ? thread.cwd : (worktree?.path ?? ''),
          status: waiting
            ? 'waiting'
            : running
              ? 'running'
              : state === 'systemError' || report?.status === 'failed'
                ? 'error'
                : 'idle',
          running,
          startedAt,
          elapsedSeconds: startedAt === null ? null : Math.max(0, managerNow() - startedAt),
          branch: worktree?.branch ?? null,
          ahead: null,
          merged: null,
          worktreeExists: worktree ? existsSync(worktree.path) : null,
          report: report ? { text: report.text, at: report.at } : null,
          unverified:
            report?.text.split(/\r?\n/).filter((line) => /^(没验：|Unverified:)/.test(line)) ?? [],
        }
      })
  }
  async refresh(managerId: string): Promise<void> {
    await Promise.all(
      this.lines(managerId).map(async (line) => {
        try {
          const { thread } = await this.tree.read(line.threadId, false)
          this.snapshots.set(line.threadId, thread)
        } catch {
          /* 断线时保留最近事实，不凭失败推断空闲。 */
        }
      }),
    )
  }
  async reserve(
    parentId: string,
    threadId: string | null,
  ): Promise<{ bind(id: string): void; release(): void }> {
    const noop = { bind: () => {}, release: () => {} }
    const manager = this.managerFor(parentId)
    if (!manager) return noop
    if (threadId === manager.threadId) return noop
    if (manager.status !== 'active')
      throw new ManagerError(
        'managerEnded',
        'This manager is ending or has ended; no new line work can start.',
      )
    if (threadId && [...this.reserved.values()].some((entry) => entry.threadId === threadId))
      return noop
    await this.refresh(manager.id)
    // 等读取结束后再同步计数并占位，两个并发 start 不能同时穿过上限。
    if (this.store.manager(manager.id)?.status !== 'active')
      throw new ManagerError('managerEnded', 'This manager has ended.')
    const lines = this.lines(manager.id)
    if (threadId && lines.some((line) => line.threadId === threadId && line.running)) return noop
    const held = [...this.reserved.values()].filter(
      (entry) =>
        entry.managerId === manager.id &&
        !lines.some((line) => line.threadId === entry.threadId && line.running),
    ).length
    const running = lines.filter((line) => line.running).length + held
    const limit =
      this.store.manager(manager.id)?.dispatch.maxRunningLines ?? manager.dispatch.maxRunningLines
    if (running >= limit)
      throw new ManagerError(
        'lineLimitReached',
        `This manager already has ${running} running lines (limit ${limit}). Finish or stop a line before starting more work.`,
        { limit, runningLines: running },
      )
    const key = randomUUID()
    this.reserved.set(key, { managerId: manager.id, threadId })
    return {
      bind: (id) => {
        const entry = this.reserved.get(key)
        if (entry) entry.threadId = id
      },
      release: () => {
        this.reserved.delete(key)
      },
    }
  }
}
