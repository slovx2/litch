// 使用已有 manager_id 索引筛选，按创建时间与 rowid 做稳定游标。不加载正文和整份历史。
import type { ManagerChange } from '../../protocol/src/manager.mjs'
import {
  MANAGER_PAGE_SIZE,
  type ManagerBoardCounts,
  type ManagerHistoryPage,
  type ManagerObjectHead,
  type ManagerObjectPage,
  type ManagerPageKind,
  type ManagerPageParams,
  type ManagerPageQuery,
} from '../../protocol/src/manager-paging.mjs'
import type { ManagerStore } from './manager-store.mjs'
import { fields, invalid } from './manager-validate.mjs'
export interface ManagerPagingSuggestion extends ManagerObjectHead {
  serial: number
}

const states: Record<ManagerPageKind, readonly string[]> = {
  decision: ['all', 'pending', 'open', 'answered', 'closed', 'expired', 'withdrawn', 'ignored'],
  request: ['all', 'pending', 'open', 'replied', 'delivered', 'ignored', 'cancelled'],
  item: ['all', 'pending', 'backlog', 'running', 'review', 'done', 'deferred', 'blocked'],
  report: ['all', 'pending', 'unread', 'read'],
  suggestion: ['all', 'pending', 'review', 'started', 'dismissed', 'withdrawn', 'expired', 'here'],
}
export function pageQuery(params: ManagerPageParams): ManagerPageQuery {
  if (
    !Object.hasOwn(states, params.kind) ||
    !states[params.kind]?.includes(params.status) ||
    !['newest', 'oldest', 'pending'].includes(params.order)
  )
    invalid('Invalid page filter or order.')
  return { kind: params.kind, status: params.status, order: params.order }
}
export function pageLimit(value: number | undefined): number {
  const limit = value ?? MANAGER_PAGE_SIZE
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    invalid('Page limit must be between 1 and 100.')
  return limit
}
interface Cursor {
  scope: string
  upper: number
  rank: number
  at: number
  id: number
}
export const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor)).toString('base64url')
export function decodeCursor(value: string | undefined, scope: string): Cursor | null {
  if (value === undefined) return null
  try {
    const cursor = fields(JSON.parse(Buffer.from(value, 'base64url').toString()))
    if (
      value.length > 2048 ||
      cursor.scope !== scope ||
      !['upper', 'rank', 'at', 'id'].every(
        (key) => Number.isSafeInteger(cursor[key]) && Number(cursor[key]) >= 0,
      )
    )
      invalid('The page cursor does not match this query.')
    return cursor as unknown as Cursor
  } catch {
    return invalid('Invalid page cursor. Reload this list.')
  }
}
const pendingStates = (kind: ManagerPageKind): readonly string[] =>
  kind === 'report'
    ? ['unread']
    : kind === 'item'
      ? ['backlog', 'running', 'review', 'blocked']
      : kind === 'suggestion'
        ? ['pending']
        : ['open']
export const headPending = (kind: ManagerPageKind, status: string): boolean =>
  pendingStates(kind).includes(status)
const source = (kind: Exclude<ManagerPageKind, 'suggestion'>) => {
  const report = kind === 'report'
  const status = report
    ? "CASE WHEN json_extract(body,'$.readRevision')=json_extract(body,'$.revision') THEN 'read' ELSE 'unread' END"
    : kind === 'request'
      ? "CASE WHEN json_extract(body,'$.status')='replied' AND json_extract(body,'$.response.ignored')=1 THEN 'ignored' ELSE json_extract(body,'$.status') END"
      : "json_extract(body,'$.status')"
  return {
    table: report ? 'manager_reports' : 'objects',
    prefix: report ? 'P-%' : kind === 'decision' ? 'D-%' : kind === 'request' ? 'R-%' : 'I-%',
    status,
    body: `json_extract(body,'$.${report ? 'body' : kind === 'decision' ? 'background' : kind === 'request' ? 'description' : 'why'}')`,
    pending: `(${status}) IN (${pendingStates(kind)
      .map((s) => `'${s}'`)
      .join(',')})`,
  }
}

export class ManagerPageQueryStore {
  readonly store: ManagerStore
  constructor(store: ManagerStore) {
    this.store = store
  }
  counts(managerId: string, suggestions: ManagerObjectHead[]): ManagerBoardCounts {
    const result = {} as ManagerBoardCounts
    for (const kind of Object.keys(states) as ManagerPageKind[]) {
      const counts: Record<string, number> = { all: 0, pending: 0 }
      const rows =
        kind === 'suggestion'
          ? suggestions.map((head) => ({ status: head.status, count: 1 }))
          : this.store.db
              .prepare(`SELECT ${source(kind).status} AS status, count(*) AS count
            FROM ${source(kind).table} WHERE manager_id=? AND id LIKE ? GROUP BY status`)
              .all(managerId, source(kind).prefix)
      for (const row of rows) {
        const status = String(row.status)
        const count = Number(row.count)
        counts.all = (counts.all ?? 0) + count
        counts[status] = (counts[status] ?? 0) + count
        if (status !== 'pending' && headPending(kind, status))
          counts.pending = (counts.pending ?? 0) + count
      }
      if (kind === 'decision') counts.closed = (counts.expired ?? 0) + (counts.withdrawn ?? 0)
      result[kind] = counts
    }
    return result
  }
  page(params: ManagerPageParams, suggestions: ManagerPagingSuggestion[] = []): ManagerObjectPage {
    const query = pageQuery(params)
    const limit = pageLimit(params.limit)
    const scope = JSON.stringify([params.managerId, query])
    const cursor = decodeCursor(params.cursor, scope)
    if (query.kind === 'suggestion')
      return this.suggestionPage(query, suggestions, limit, scope, cursor)
    const spec = source(query.kind)
    const upper =
      cursor?.upper ??
      Number(
        this.store.db
          .prepare(`SELECT coalesce(max(rowid),0) AS n FROM ${spec.table} WHERE manager_id=?`)
          .get(params.managerId)?.n,
      )
    const args: (string | number)[] = [params.managerId, spec.prefix, upper]
    let where = 'manager_id=? AND id LIKE ? AND rowid<=?'
    if (query.status === 'pending') where += ` AND (${spec.pending})`
    else if (query.status === 'closed') where += ` AND (${spec.status}) IN ('expired','withdrawn')`
    else if (query.status !== 'all') {
      where += ` AND (${spec.status})=?`
      args.push(query.status)
    }
    const total = Number(
      this.store.db.prepare(`SELECT count(*) AS n FROM ${spec.table} WHERE ${where}`).get(...args)
        ?.n,
    )
    const rank = query.order === 'pending' ? `CASE WHEN ${spec.pending} THEN 1 ELSE 0 END` : '0'
    const at = "coalesce(json_extract(body,'$.createdAt'),0)"
    const direction = query.order === 'oldest' ? 'ASC' : 'DESC'
    const sign = query.order === 'oldest' ? '>' : '<'
    if (cursor) {
      where += ` AND ((${rank}) < ? OR ((${rank}) = ? AND ((${at}) ${sign} ? OR ((${at}) = ? AND rowid ${sign} ?))))`
      args.push(cursor.rank, cursor.rank, cursor.at, cursor.at, cursor.id)
    }
    const rows = this.store.db
      .prepare(`SELECT rowid AS serial, id, json_extract(body,'$.title') AS title,
      substr(coalesce(${spec.body},''),1,160) AS preview, ${spec.status} AS status,
      json_extract(body,'$.revision') AS revision, ${at} AS createdAt,
      json_extract(body,'$.updatedAt') AS updatedAt, ${rank} AS rank
      FROM ${spec.table} WHERE ${where} ORDER BY rank DESC, createdAt ${direction}, serial ${direction} LIMIT ?`)
      .all(...args, limit + 1)
    const entries = rows.slice(0, limit).map(
      (row): ManagerObjectHead => ({
        id: String(row.id) as ManagerObjectHead['id'],
        kind: query.kind,
        title: String(row.title),
        preview: String(row.preview),
        status: String(row.status),
        pending: headPending(query.kind, String(row.status)),
        revision: Number(row.revision),
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
      }),
    )
    const last = rows[limit - 1]
    return {
      query,
      entries,
      total,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({
              scope,
              upper,
              rank: Number(last.rank),
              at: Number(last.createdAt),
              id: Number(last.serial),
            })
          : null,
    }
  }
  private suggestionPage(
    query: ManagerPageQuery,
    heads: ManagerPagingSuggestion[],
    limit: number,
    scope: string,
    cursor: Cursor | null,
  ): ManagerObjectPage {
    // 提案来自会话库的摘要列；用 rowid 固定创建上界，同秒新增也不会挤进旧游标。
    const all = heads.map((head) => ({
      head,
      rank: query.order === 'pending' && head.pending ? 1 : 0,
    }))
    const upper = cursor?.upper ?? heads.reduce((max, head) => Math.max(max, head.serial), 0)
    const sign = query.order === 'oldest' ? 1 : -1
    const filtered = all
      .filter(
        ({ head }) =>
          head.serial <= upper && (query.status === 'all' || head.status === query.status),
      )
      .sort(
        (a, b) =>
          b.rank - a.rank ||
          sign * (a.head.createdAt - b.head.createdAt) ||
          sign * (a.head.serial - b.head.serial),
      )
    const eligible = cursor
      ? filtered.filter(
          (row) =>
            row.rank < cursor.rank ||
            (row.rank === cursor.rank &&
              (sign * (row.head.createdAt - cursor.at) > 0 ||
                (row.head.createdAt === cursor.at && sign * (row.head.serial - cursor.id) > 0))),
        )
      : filtered
    const last = eligible[limit - 1]
    return {
      query,
      total: filtered.length,
      entries: eligible.slice(0, limit).map(({ head: { serial: _serial, ...head } }) => head),
      nextCursor:
        eligible.length > limit && last
          ? encodeCursor({
              scope,
              upper,
              rank: last.rank,
              at: last.head.createdAt,
              id: last.head.serial,
            })
          : null,
    }
  }
  history(managerId: string, id: string, value?: string, size?: number): ManagerHistoryPage {
    const limit = pageLimit(size)
    const scope = JSON.stringify([managerId, id, 'history'])
    const cursor = decodeCursor(value, scope)
    const upper =
      cursor?.upper ??
      Number(
        this.store.db
          .prepare('SELECT coalesce(max(seq),0) AS n FROM changes WHERE manager_id=?')
          .get(managerId)?.n,
      )
    const rows = this.store.db
      .prepare(`SELECT seq,body FROM changes WHERE manager_id=? AND seq<=? AND seq<?
      AND json_extract(body,'$.objectId')=? ORDER BY seq DESC LIMIT ?`)
      .all(managerId, upper, cursor?.id ?? upper + 1, id, limit + 1)
    const last = rows[limit - 1]
    return {
      changes: rows.slice(0, limit).map((row) => JSON.parse(String(row.body)) as ManagerChange),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ scope, upper, rank: 0, at: 0, id: Number(last.seq) })
          : null,
    }
  }
}
