import {
  type ManagerIssue,
  type ManagerIssueQuery,
  managerIssueHasDiscussion,
} from '../../../protocol/src/manager-issues.mjs'
import { ChannelError } from '../channel/protocol.mjs'
import type { ManagerBoardView } from '../model-manager.mjs'
import { type ManagerIssuesView, managerIssueQueryKey } from '../model-manager-issues.mjs'
import { managerIssuePending } from '../projection/manager-public-issues.mjs'
import { copyValue } from '../value.mjs'

/** 预览播种：第一次投影某个经理时调用，返回要加入或同编号覆盖的 issue。 */
export type MockManagerIssueSeed = (
  key: string,
  specials: readonly ManagerIssue[],
) => ManagerIssue[]

export class MockManagerIssues {
  private readonly seed: MockManagerIssueSeed | undefined
  constructor(options: { seed?: MockManagerIssueSeed } = {}) {
    this.seed = options.seed
  }
  private readonly records = new Map<string, Map<string, ManagerIssue>>()
  private readonly caches = new Map<string, ManagerIssuesView>()
  private readonly queries = new Map<string, Map<string, ManagerIssueQuery>>()
  private readonly idem = new Map<string, unknown>()
  private seq = 0
  view(key: string) {
    return this.caches.get(key)
  }
  private data(key: string, board: ManagerBoardView) {
    let records = this.records.get(key)
    const fresh = !records
    if (!records) {
      records = new Map()
      this.records.set(key, records)
    }
    const ordered = [...(board.posts ?? [])].sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id, 'en', { numeric: true }),
    )
    const added: ManagerIssue[] = []
    for (const post of ordered) {
      const previous = records.get(post.id)
      const id = post.id
      const decision = board.decisions.find((d) => d.id === post.id)
      const request = board.requests?.find((r) => r.id === post.id)
      const status =
        decision?.status ??
        request?.status ??
        (post.kind === 'report'
          ? post.unread
            ? 'unread'
            : 'read'
          : String(post.fields.status ?? 'pending'))
      const issue: ManagerIssue = {
        id,
        kind: post.kind,
        title: post.title,
        body: post.body,
        status: status as ManagerIssue['status'],
        stateGroup: 'closed',
        author: { kind: 'manager' },
        revision:
          post.revision +
          (previous ? previous.revision - (previous.quick.revision ?? post.revision) : 0),
        createdAt: post.createdAt,
        updatedAt: post.updatedAt,
        followUp: previous?.followUp ?? {
          state: status === 'open' || status === 'pending' ? 'on' : 'off',
          changedAt: post.createdAt,
          changedBy: 'manager',
        },
        discussion: {
          opened: previous?.discussion.opened === true,
          comments: previous?.discussion.comments ?? [],
          questions: post.discussion.messages,
          summary: post.discussion.summary,
          legacy: post.discussion,
        },
        relations: (board.relations ?? []).filter(
          (edge) => edge.from.target === id || edge.to.target === id,
        ),
        timeline: previous?.timeline ?? [],
        unread: post.unread ?? false,
        quick: {
          revision: post.revision,
          ...(decision
            ? {
                decision: {
                  options: decision.options,
                  answerable: decision.status === 'open',
                  ignored: decision.status === 'ignored',
                },
              }
            : request
              ? {
                  request: {
                    buttonLabel: request.buttonLabel,
                    deliverable: request.status === 'open',
                  },
                }
              : post.kind === 'report'
                ? { report: { unread: !!post.unread, canMarkRead: !!post.unread } }
                : {
                    suggestion: {
                      proposalId: post.proposalId!,
                      canStart: status === 'pending',
                      reviewed: true,
                    },
                  }),
        },
      }
      issue.stateGroup =
        issue.kind === 'report'
          ? (issue.status as 'read' | 'unread')
          : managerIssuePending(issue)
            ? 'pending'
            : 'closed'
      records.set(id, issue)
      if (!previous) added.push(issue)
    }
    // 建议投影可能晚于经理首屏到达；补种新到的特殊条目，不重置已有讨论或 X-n。
    if (this.seed && (fresh || added.length))
      for (const issue of this.seed(key, added))
        if (fresh || issue.kind !== 'ordinary') records.set(issue.id, issue)
    return records
  }
  /** 缓存里的页：加载过更多时保留从头到已加载处的全部条目（与核心缓存的合并结果同形）。 */
  private cached(records: Map<string, ManagerIssue>, query: ManagerIssueQuery) {
    if (!query.cursor) return this.page(records, query)
    const { cursor, ...rest } = query
    return {
      ...this.page(records, { ...rest, limit: Number(cursor) + (query.limit ?? 30) }),
      query,
    }
  }
  private refreshCache(key: string, records: Map<string, ManagerIssue>, issue: ManagerIssue) {
    const cache = this.caches.get(key)
    if (!cache) return
    cache.details[issue.id] = copyValue(issue)
    for (const [queryKey, query] of this.queries.get(key) ?? [])
      cache.pages[queryKey] = this.cached(records, query)
  }
  /**
   * 预览里模拟经理回复：跟进开着才回（暂停时经理不回），回复标成未读。
   * 由 mock-manager.mts 在用户评论后延时调用；返回是否回了。
   */
  reply(key: string, id: string, body: string, at: number): boolean {
    const records = this.records.get(key)
    const issue = records?.get(id)
    if (!records || !issue || issue.followUp.state !== 'on') return false
    const comment = {
      id: `mock-comment-${++this.seq}`,
      revision: 1,
      author: { kind: 'manager' as const },
      body,
      createdAt: at,
      updatedAt: at,
      replyTo: null,
    }
    issue.discussion.comments.push(comment)
    issue.timeline.push({
      id: `comment:${comment.id}:1`,
      kind: 'comment',
      actor: 'manager',
      at,
      summary: body,
      commentId: comment.id,
    })
    issue.unread = true
    issue.updatedAt = at
    this.refreshCache(key, records, issue)
    return true
  }
  private page(records: Map<string, ManagerIssue>, q: ManagerIssueQuery) {
    const rows = [...records.values()].filter(
      (i) =>
        (q.kinds ?? ['ordinary']).includes(i.kind) &&
        (!q.discussionsOnly || i.kind === 'ordinary' || managerIssueHasDiscussion(i)) &&
        (!q.statuses?.length || q.statuses.includes(i.status)) &&
        (!q.authors?.length || q.authors.includes(i.author.kind)) &&
        (!q.followUp || q.followUp === 'all' || q.followUp === i.followUp.state) &&
        (q.unread === undefined || q.unread === i.unread),
    )
    rows.sort(
      (a, b) =>
        (q.order === 'pending'
          ? Number(managerIssuePending(b)) - Number(managerIssuePending(a))
          : 0) ||
        (q.order === 'oldest'
          ? a.createdAt - b.createdAt
          : q.order === 'updated'
            ? b.updatedAt - a.updatedAt
            : b.createdAt - a.createdAt) ||
        b.id.localeCompare(a.id, 'en', { numeric: true }),
    )
    const offset = Number(q.cursor ?? 0),
      limit = q.limit ?? 30
    return {
      query: q,
      total: rows.length,
      nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
      entries: rows.slice(offset, offset + limit).map((i) => ({
        id: i.id,
        kind: i.kind,
        title: i.title,
        preview: i.body.slice(0, 300),
        status: i.status,
        stateGroup: i.stateGroup,
        author: i.author.kind,
        followUp: i.followUp.state,
        unread: i.unread,
        revision: i.revision,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
      })),
    }
  }
  command(
    key: string,
    board: ManagerBoardView,
    name: string,
    p: Record<string, any>,
    at: number,
  ): unknown {
    const records = this.data(key, board)
    const cache = this.caches.get(key) ?? { pages: {}, details: {}, loading: [], error: null }
    this.caches.set(key, cache)
    if (name === 'managers.issues.list') {
      const { deviceId: _, ...q } = p
      const query = q as ManagerIssueQuery
      const queryKey = managerIssueQueryKey(query)
      let queries = this.queries.get(key)
      if (!queries) {
        queries = new Map()
        this.queries.set(key, queries)
      }
      queries.set(queryKey, query)
      const page = this.page(records, query)
      cache.pages[queryKey] = this.cached(records, query)
      return { page: copyValue(page) }
    }
    const idem = p.idempotencyKey ? JSON.stringify([key, name, p.idempotencyKey]) : null
    if (idem && this.idem.has(idem)) return copyValue(this.idem.get(idem))
    let issue = records.get(p.id)
    if (name === 'managers.issue.create') {
      if (typeof p.title !== 'string' || !p.title.trim())
        throw new ChannelError('invalid', 'Title required')
      issue = {
        id: `X-${[...records.values()].filter((i) => i.kind === 'ordinary').length + 1}`,
        kind: 'ordinary',
        title: p.title,
        body: p.body,
        status: 'open',
        stateGroup: 'open',
        author: { kind: 'user' },
        revision: 1,
        createdAt: at,
        updatedAt: at,
        followUp: { state: p.followUp ?? 'on', changedAt: at, changedBy: 'user' },
        discussion: { comments: [], questions: [], summary: null },
        timeline: [],
        relations: [],
        quick: {},
        unread: false,
      }
      records.set(issue.id, issue)
    } else {
      if (!issue) throw new ChannelError('notFound', 'Issue not found')
      if (name !== 'managers.issue.read' && p.revision !== issue.revision)
        throw new ChannelError('rejected', 'The issue changed; read again')
      if (name === 'managers.issue.comment') {
        if (typeof p.body !== 'string' || !p.body.trim())
          throw new ChannelError('invalid', 'Comment required')
        const previous =
          p.commentId === undefined
            ? undefined
            : issue.discussion.comments.find((c) => c.id === p.commentId)
        if (p.commentId !== undefined || p.commentRevision !== undefined) {
          if (
            !previous ||
            previous.author.kind !== 'user' ||
            previous.revision !== p.commentRevision
          )
            throw new ChannelError('rejected', 'Only your current comment revision can be edited')
        }
        const id = previous?.id ?? `mock-comment-${++this.seq}`
        const comment = {
          id,
          revision: (previous?.revision ?? 0) + 1,
          author: { kind: 'user' as const },
          body: p.body,
          createdAt: previous?.createdAt ?? at,
          updatedAt: at,
          replyTo: previous?.replyTo ?? p.replyTo ?? null,
        }
        if (previous) Object.assign(previous, comment)
        else issue.discussion.comments.push(comment)
        issue.timeline.push({
          id: `comment:${id}:${comment.revision}`,
          kind: previous ? 'edited' : 'comment',
          actor: 'user',
          at,
          summary: p.body,
          commentId: id,
        })
      } else if (name === 'managers.issue.update') {
        if (
          issue.kind !== 'ordinary' &&
          Object.keys(p.patch).some((key) => key !== 'discussionOpened')
        )
          throw new ChannelError('rejected', 'Use the special issue quick actions')
        const { followUp, discussionOpened, ...patch } = p.patch
        if (discussionOpened === true) issue.discussion.opened = true
        Object.assign(issue, patch)
        if (followUp) issue.followUp = { state: followUp, changedAt: at, changedBy: 'user' }
        issue.revision++
        issue.stateGroup = managerIssuePending(issue) ? 'open' : 'closed'
        issue.timeline.push({
          id: `change:mock-${++this.seq}`,
          kind: followUp ? 'followUp' : patch.status ? 'status' : 'edited',
          actor: 'user',
          at,
          summary: typeof p.why === 'string' ? p.why : '',
        })
      } else if (name === 'managers.issue.follow') {
        issue.followUp = { state: p.state, changedAt: at, changedBy: 'user' }
        issue.revision++
        issue.timeline.push({
          id: `change:mock-${++this.seq}`,
          kind: 'followUp',
          actor: 'user',
          at,
          summary: typeof p.why === 'string' ? p.why : '',
        })
      } else if (name === 'managers.issue.seen') issue.unread = issue.quick.report?.unread ?? false
      if (name !== 'managers.issue.read') issue.updatedAt = at
    }
    this.refreshCache(key, records, issue)
    const result = { issue: copyValue(issue) }
    if (idem) this.idem.set(idem, result)
    return result
  }
}
