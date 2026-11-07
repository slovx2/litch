// 首屏只读摘要；工作线的引擎读取独立进行，历史在用户展开时按 seq 取页。
import type {
  Manager,
  ManagerActivity,
  ManagerChange,
  ManagerObjectId,
} from '../../protocol/src/manager.mjs'
import {
  MANAGER_PAGING_METHOD,
  type ManagerBoardCounts,
  type ManagerBoardSummary,
  type ManagerLinesPage,
  type ManagerObjectDetail,
  type ManagerPageParams,
} from '../../protocol/src/manager-paging.mjs'
import type { DeviceManagers } from './manager.mjs'
import { isDecision } from './manager-board.mjs'
import { ManagerPageQueryStore, type ManagerPagingSuggestion } from './manager-page-query.mjs'
import { projectedLineRelations, projectedRelations } from './manager-relations.mjs'
import { fields, keys, ManagerError, text } from './manager-validate.mjs'

export class ManagerPaging {
  readonly owner: DeviceManagers
  readonly queries: ManagerPageQueryStore
  private readonly refreshing = new Map<string, Promise<ManagerLinesPage>>()
  constructor(owner: DeviceManagers) {
    this.owner = owner
    this.queries = new ManagerPageQueryStore(owner.store)
  }
  private managerRecord(id: string): Manager {
    const manager = this.owner.store.manager(id)
    if (!manager) throw new ManagerError('unknownManager', 'This manager does not exist.')
    return manager
  }
  suggestions(id: string): ManagerPagingSuggestion[] {
    const manager = this.managerRecord(id)
    const history = this.owner.store.history(id)
    const threads = new Set([manager.threadId, ...history])
    for (const line of this.owner.tree.store.children())
      if (this.owner.lines.mark(line.threadId)?.managerId === id) threads.add(line.threadId)
    return this.owner.tree.store.suggestionHeads([...threads]).flatMap((proposal) => {
      const version = this.owner.store.suggestionVersion(id, `S-${proposal.id}`)
      const review = this.owner.store.suggestionReview(id, proposal.id)
      const own = proposal.threadId === manager.threadId || history.includes(proposal.threadId)
      const status =
        proposal.status === 'pending' && !own && review?.state !== 'endorsed'
          ? review?.state === 'dismissed'
            ? 'dismissed'
            : 'review'
          : proposal.status
      return [
        {
          id: `S-${proposal.id}` as const,
          serial: proposal.serial,
          kind: 'suggestion' as const,
          title: proposal.title,
          preview: proposal.preview,
          status,
          pending: status === 'pending' || status === 'review',
          revision: version?.revision ?? 1,
          createdAt: proposal.createdAt,
          updatedAt: version?.updatedAt ?? proposal.createdAt,
        },
      ]
    })
  }
  snapshot(id: string): ManagerLinesPage {
    const lines = this.owner.lines.lines(id).map(({ report, unverified, ...line }) => ({
      ...line,
      reportPreview: report?.text.slice(0, 240) ?? null,
      unverifiedCount: unverified.length,
      checkedAt: this.owner.lines.checkedAt.get(line.threadId) ?? null,
    }))
    const times = lines.map((line) => line.checkedAt)
    return {
      lines,
      checkedAt:
        times.length && times.every((at) => at !== null) ? Math.min(...(times as number[])) : null,
      failed: 0,
    }
  }
  async lines(id: string): Promise<ManagerLinesPage> {
    const existing = this.refreshing.get(id)
    if (existing) return existing
    const refresh = (async () => {
      const failed = await this.owner.lines.refresh(id)
      return { ...this.snapshot(id), failed }
    })()
    this.refreshing.set(id, refresh)
    try {
      return await refresh
    } finally {
      this.refreshing.delete(id)
    }
  }
  activities(id: string, limit: number): ManagerActivity[] {
    // 只从索引末端取少量字段，不解析 before/after 大对象。
    const rows = this.owner.store.db
      .prepare(`SELECT json_extract(body,'$.id') AS id,
      json_extract(body,'$.objectId') AS objectId, json_extract(body,'$.by') AS actor,
      json_extract(body,'$.at') AS at, json_extract(body,'$.why') AS why
      FROM changes WHERE manager_id=? ORDER BY seq DESC LIMIT ?`)
      .all(id, limit)
    const result: ManagerActivity[] = rows.map((row) => {
      const objectId = String(row.objectId)
      return {
        id: String(row.id),
        at: Number(row.at),
        text: String(row.why),
        source: {
          kind:
            row.actor === 'manager'
              ? 'manager'
              : row.actor === 'user' || row.actor === 'user-conversation'
                ? 'user'
                : 'system',
        },
        kind:
          objectId === 'manager'
            ? 'manager'
            : objectId === 'status'
              ? 'status'
              : objectId.startsWith('D-')
                ? 'decision'
                : objectId.startsWith('R-')
                  ? 'request'
                  : 'item',
        objectId:
          objectId === 'manager' || objectId === 'status' ? null : (objectId as ManagerObjectId),
        threadId: null,
        changeId: String(row.id),
      }
    })
    for (const line of this.owner.lines.lines(id))
      if (line.report)
        result.push({
          id: `report:${line.threadId}:${this.owner.store.report(line.threadId)?.turnId}`,
          kind: 'report',
          source: { kind: 'line', threadId: line.threadId, title: line.title },
          at: line.report.at,
          text: line.report.text,
          objectId: null,
          threadId: line.threadId,
          changeId: null,
        })
    return result.sort((a, b) => b.at - a.at).slice(0, limit)
  }
  manager(
    id: string,
    counts?: ManagerBoardCounts,
    lines?: ManagerLinesPage,
    activity?: ManagerActivity[],
  ): Manager {
    const manager = this.managerRecord(id)
    const totals = counts ?? this.queries.counts(id, this.suggestions(id))
    const snapshot = lines ?? this.snapshot(id)
    const latest = (activity ?? this.activities(id, 1))[0] ?? null
    return {
      ...manager,
      reset: this.owner.resets.state(manager),
      historyThreadIds: this.owner.store.history(id),
      pendingDecisions: totals.decision.pending ?? 0,
      pendingRequests: totals.request.pending ?? 0,
      pendingReports: totals.report.unread ?? 0,
      pendingSuggestions: totals.suggestion.pending ?? 0,
      runningLines: snapshot.lines.filter((line) => line.running).length,
      latestActivity: latest ? { ...latest, text: latest.text.slice(0, 400) } : null,
      updatedAt: Math.max(manager.updatedAt, latest?.at ?? 0),
    }
  }
  summary(id: string): ManagerBoardSummary {
    const suggestions = this.suggestions(id)
    const counts = this.queries.counts(id, suggestions)
    const lines = this.snapshot(id)
    const activities = this.activities(id, 10)
    const references = new Map<string, Set<ManagerObjectId>>()
    for (const relation of projectedLineRelations(this.owner.store, id)) {
      const thread = relation.from.kind === 'thread' ? relation.from : relation.to
      const object = relation.from.kind === 'thread' ? relation.to : relation.from
      if (object.kind !== 'issue' && object.kind !== 'item') continue
      const ids = references.get(thread.target) ?? new Set<ManagerObjectId>()
      ids.add(object.target as ManagerObjectId)
      references.set(thread.target, ids)
    }
    return {
      lineReferences: Object.fromEntries(
        [...references].map(([thread, ids]) => [thread, [...ids]]),
      ),
      manager: this.manager(id, counts, lines, activities),
      counts,
      situation: this.owner.store.situation(id),
      lines,
      activities: activities.map((activity) => ({
        ...activity,
        text: activity.text.slice(0, 400),
      })),
      initial: this.queries.page({
        managerId: id,
        kind: 'decision',
        status: 'open',
        order: 'newest',
      }),
    }
  }
  detail(managerId: string, id: string): ManagerObjectDetail {
    const object =
      id.startsWith('P-') || id.startsWith('S-') ? null : this.owner.writer.object(managerId, id)
    const post = id.startsWith('I-') ? null : this.owner.posts.current(managerId, id)
    const decision = object && isDecision(object) ? object : null
    const question = decision ? this.owner.store.question(managerId, id) : null
    const row =
      decision?.status === 'open'
        ? this.owner.store.db
            .prepare(`SELECT body FROM changes
      WHERE manager_id=? AND json_extract(body,'$.objectId')=?
      AND json_extract(body,'$.before.status') != json_extract(body,'$.after.status') ORDER BY seq DESC LIMIT 1`)
            .get(managerId, id)
        : undefined
    const change = row ? (JSON.parse(String(row.body)) as ManagerChange) : null
    const closed = change?.before?.closed as ManagerObjectDetail['previousClosed']
    return {
      object: decision && question ? { ...decision, discussion: question.discussion } : object,
      post,
      relations: projectedRelations(this.owner.store, managerId).filter(
        (r) => r.from.target === id || r.to.target === id,
      ),
      previousClosed:
        change?.after?.status === 'open' &&
        ['expired', 'withdrawn'].includes(String(change.before?.status))
          ? (closed ?? null)
          : null,
      reopened:
        change?.after?.status === 'open' &&
        change.before?.status === 'ignored' &&
        change.by === 'manager'
          ? { by: change.by, at: change.at, reason: change.why }
          : null,
    }
  }
  async call(method: string, given: unknown): Promise<unknown> {
    const params = fields(given ?? {})
    if (method === MANAGER_PAGING_METHOD.catalog) {
      keys(params, [])
      return { managers: this.owner.store.managers().map((manager) => this.manager(manager.id)) }
    }
    const managerId = text(params.managerId, 'managerId')
    this.managerRecord(managerId)
    switch (method) {
      case MANAGER_PAGING_METHOD.summary:
        keys(params, ['managerId'])
        return { summary: this.summary(managerId) }
      case MANAGER_PAGING_METHOD.page:
        keys(params, ['managerId', 'kind', 'status', 'order', 'limit', 'cursor'])
        return this.queries.page(
          params as unknown as ManagerPageParams,
          params.kind === 'suggestion' ? this.suggestions(managerId) : [],
        )
      case MANAGER_PAGING_METHOD.detail:
        keys(params, ['managerId', 'id'])
        return this.detail(managerId, text(params.id, 'id'))
      case MANAGER_PAGING_METHOD.history: {
        keys(params, ['managerId', 'id', 'cursor', 'limit'])
        const id = text(params.id, 'id')
        if (id.startsWith('P-') || id.startsWith('S-')) this.owner.posts.current(managerId, id)
        else this.owner.writer.object(managerId, id)
        return this.queries.history(
          managerId,
          id,
          params.cursor as string | undefined,
          params.limit as number | undefined,
        )
      }
      case MANAGER_PAGING_METHOD.lines:
        keys(params, ['managerId', 'refresh'])
        if (params.refresh !== undefined && typeof params.refresh !== 'boolean')
          throw new ManagerError('invalidManager', 'refresh must be a boolean.')
        return params.refresh ? this.lines(managerId) : this.snapshot(managerId)
      default:
        throw new ManagerError('methodNotFound', `Unknown manager paging method: ${method}`)
    }
  }
}
