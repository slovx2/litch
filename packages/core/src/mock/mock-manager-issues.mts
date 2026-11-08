import type { ManagerIssue, ManagerIssueQuery } from '../../../protocol/src/manager-issues.mjs'
import { ChannelError } from '../channel/protocol.mjs'
import type { ManagerBoardView } from '../model-manager.mjs'
import { type ManagerIssuesView, managerIssueQueryKey } from '../model-manager-issues.mjs'
import { managerIssuePending } from '../projection/manager-public-issues.mjs'
import { copyValue } from '../value.mjs'

export class MockManagerIssues {
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
    if (!records) {
      records = new Map()
      this.records.set(key, records)
    }
    const ordered = [...(board.posts ?? [])].sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id, 'en', { numeric: true }),
    )
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
          comments: previous?.discussion.comments ?? [],
          questions: post.discussion.messages,
          summary: post.discussion.summary,
          legacy: post.discussion,
        },
        relations: [],
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
    }
    return records
  }
  private page(records: Map<string, ManagerIssue>, q: ManagerIssueQuery) {
    const rows = [...records.values()].filter(
      (i) =>
        (q.kinds ?? ['ordinary']).includes(i.kind) &&
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
      cache.pages[queryKey] = page
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
        if (issue.kind !== 'ordinary')
          throw new ChannelError('rejected', 'Use the special issue quick actions')
        const { followUp, ...patch } = p.patch
        Object.assign(issue, patch)
        if (followUp) issue.followUp = { state: followUp, changedAt: at, changedBy: 'user' }
        issue.revision++
        issue.stateGroup = managerIssuePending(issue) ? 'open' : 'closed'
      } else if (name === 'managers.issue.follow') {
        issue.followUp = { state: p.state, changedAt: at, changedBy: 'user' }
        issue.revision++
      } else if (name === 'managers.issue.seen') issue.unread = issue.quick.report?.unread ?? false
      if (name !== 'managers.issue.read') issue.updatedAt = at
    }
    cache.details[issue.id] = copyValue(issue)
    for (const [queryKey, query] of this.queries.get(key) ?? [])
      cache.pages[queryKey] = this.page(records, query)
    const result = { issue: copyValue(issue) }
    if (idem) this.idem.set(idem, result)
    return result
  }
}
