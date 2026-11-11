// 公共 issue 只投影特殊对象；评论、跟进与投递在经理库的同一事务中保存。
import { randomUUID } from 'node:crypto'
import { EXTENSION } from '../../protocol/src/device.mjs'
import { managerRequestStatus } from '../../protocol/src/manager.mjs'
import {
  type ManagerIssue,
  type ManagerIssueActivityNotification,
  type ManagerIssueAuthorKind,
  type ManagerIssueChangedNotification,
  type ManagerIssueComment,
  type ManagerIssueFollowUpState,
  type ManagerIssueId,
  type ManagerIssuePage,
  type ManagerIssueQuery,
  MANAGER_ISSUE_METHOD as METHOD,
  managerIssueRefKind,
  MANAGER_ISSUE_NOTIFICATION as NOTICE,
} from '../../protocol/src/manager-issues.mjs'
import type { ManagerPost } from '../../protocol/src/manager-posts.mjs'
import { formatSessionEvent } from '../../protocol/src/session-tree.mjs'
import type { DeviceManagers } from './manager.mjs'
import { addRelations, projectedRelations } from './manager-relations.mjs'
import { isRequest } from './manager-requests.mjs'
import { managerNow } from './manager-store.mjs'
import { fields, invalid, keys, ManagerError, text } from './manager-validate.mjs'

interface Meta {
  discussionOpened?: boolean
  followUp?: ManagerIssueFollowUpState
  revision: number
  updatedAt: number
}
const fail = (reason: string, message: string): never => {
  throw new ManagerError(reason, message)
}
const pending = (issue: ManagerIssue) =>
  issue.kind !== 'report' &&
  ['open', 'pending', 'endorsed', 'in_progress', 'blocked'].includes(issue.status)

export class ManagerIssues {
  private readonly specialVersions = new Map<string, Map<string, string>>()
  private readonly seenPending = new Map<
    string,
    {
      promise: Promise<unknown>
      timer: NodeJS.Timeout
      reject(error: unknown): void
    }
  >()
  private closed = false
  readonly owner: DeviceManagers
  constructor(owner: DeviceManagers) {
    this.owner = owner
  }
  private get store() {
    return this.owner.store
  }
  seen(given: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new ManagerError('closed', 'Manager service is closed.'))
    const p = fields(given)
    keys(p, ['managerId', 'id', 'revision'])
    const key = JSON.stringify([text(p.managerId, 'managerId'), text(p.id, 'id'), p.revision])
    const pending = this.seenPending.get(key)
    if (pending) return pending.promise
    let reject!: (error: unknown) => void
    let timer!: NodeJS.Timeout
    // 固定合并窗口不因后续请求延长；只延迟已读，列表和摘要无需等待它。
    const promise = new Promise<unknown>((resolve, fail) => {
      reject = fail
      timer = setTimeout(() => {
        this.seenPending.delete(key)
        try {
          resolve(this.call(METHOD.seen, given))
        } catch (error) {
          fail(error)
        }
      }, 25)
    })
    this.seenPending.set(key, { promise, timer, reject })
    return promise
  }
  close(): void {
    this.closed = true
    for (const pending of this.seenPending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new ManagerError('closed', 'Manager service is closed.'))
    }
    this.seenPending.clear()
  }
  specialChanged(managerId: string): void {
    const known = this.specialVersions.get(managerId) ?? new Map<string, string>()
    this.specialVersions.set(managerId, known)
    const relations = this.store.relations(managerId)
    for (const post of this.owner.posts.list(managerId, [])) {
      const raw = this.special(managerId, post, post.id)
      const fingerprint = JSON.stringify([
        raw.revision,
        raw.status,
        raw.discussion,
        raw.unread,
        relations.filter((r) => r.from.target === raw.id || r.to.target === raw.id),
      ])
      if (known.get(post.id) === fingerprint) continue
      known.set(post.id, fingerprint)
      this.broadcast(managerId, this.get(managerId, post.id, false), 'updated')
    }
  }
  private resolve(managerId: string, ref: string): ManagerIssueId {
    const kind = managerIssueRefKind(ref)
    if (kind === 'invalid' || (kind === 'ordinary' && !this.store.issue(managerId, ref)))
      fail('unknownIssue', 'This issue does not belong to this manager.')
    if (kind === 'special') this.owner.posts.current(managerId, ref)
    return ref as ManagerIssueId
  }
  private special(managerId: string, post: ManagerPost, id: ManagerIssueId): ManagerIssue {
    const object = this.store.object(managerId, post.id)
    const review = post.proposalId ? this.store.suggestionReview(managerId, post.proposalId) : null
    const ownSuggestion =
      post.kind === 'suggestion' &&
      (post.sourceThreadId === this.store.manager(managerId)?.threadId ||
        this.store.history(managerId).includes(post.sourceThreadId ?? ''))
    const rawStatus =
      object && isRequest(object)
        ? managerRequestStatus(object)
        : (object?.status ??
          (post.kind === 'report' ? (post.unread ? 'unread' : 'read') : post.fields.status))
    const status = (
      post.kind === 'suggestion' && rawStatus === 'pending' && (review || ownSuggestion)
        ? (review?.state ?? 'endorsed')
        : rawStatus === 'here'
          ? 'started'
          : rawStatus === 'withdrawn' && post.kind === 'suggestion'
            ? 'dismissed'
            : rawStatus
    ) as ManagerIssue['status']
    return {
      id,
      kind: post.kind,
      title: post.title,
      body: post.body,
      status,
      stateGroup: 'closed',
      author: { kind: 'manager' },
      revision: post.revision,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      followUp: {
        state: status === 'open' || status === 'endorsed' ? 'on' : 'off',
        changedAt: post.createdAt,
        changedBy: 'manager',
      },
      discussion: {
        comments: [],
        questions: post.discussion.messages,
        summary: post.discussion.summary,
        legacy: post.discussion,
      },
      relations: [],
      timeline: [],
      unread: post.unread === true,
      quick: {
        revision: post.revision,
        ...(post.kind === 'decision'
          ? {
              decision: {
                options:
                  'options' in (object ?? {})
                    ? (object as import('../../protocol/src/manager.mjs').ManagerDecision).options
                    : [],
                answerable: status === 'open',
                ignored: status === 'ignored',
              },
            }
          : post.kind === 'request'
            ? {
                request: {
                  buttonLabel:
                    typeof post.fields.buttonLabel === 'string' ? post.fields.buttonLabel : null,
                  deliverable: status === 'open',
                },
              }
            : post.kind === 'report'
              ? { report: { unread: !!post.unread, canMarkRead: !!post.unread } }
              : {
                  suggestion: {
                    proposalId: post.proposalId!,
                    canStart: rawStatus === 'pending' && review?.state !== 'dismissed',
                    reviewed: !!review || ownSuggestion,
                  },
                }),
      },
    }
  }
  get(managerId: string, ref: string, detail = true): ManagerIssue {
    const id = this.resolve(managerId, ref)
    const raw = id.startsWith('X-')
      ? (this.store.issue(managerId, id) as ManagerIssue)
      : this.special(managerId, this.owner.posts.current(managerId, id), id)
    const meta = this.store.issueMeta(managerId, id) as Meta | null
    const issue = structuredClone(raw)
    issue.revision += meta?.revision ?? 0
    issue.updatedAt = Math.max(issue.updatedAt, meta?.updatedAt ?? 0)
    if (meta?.followUp) issue.followUp = meta.followUp
    issue.discussion.opened =
      meta?.discussionOpened === true ||
      issue.discussion.questions.length > 0 ||
      this.store.issueHasComments(managerId, id)
    issue.stateGroup =
      issue.kind === 'report'
        ? (issue.status as 'read' | 'unread')
        : pending(issue)
          ? issue.kind === 'ordinary'
            ? 'open'
            : 'pending'
          : 'closed'
    issue.unread ||= this.store.issueUnread(managerId, id, 'user')
    // 列表只取头字段；不能为了分页遍历所有议题的评论和整份审计。
    if (!detail) return issue
    issue.discussion.comments = this.store.issueComments(managerId, id) as ManagerIssueComment[]
    issue.relations = projectedRelations(this.store, managerId).filter(
      (r) => r.from.target === id || r.to.target === id,
    )
    issue.timeline = [
      {
        id: `created:${id}`,
        kind: 'created',
        actor: issue.author.kind,
        at: issue.createdAt,
        summary: issue.title,
      },
    ]
    for (const comment of issue.discussion.comments)
      issue.timeline.push({
        id: `comment:${comment.id}`,
        kind: 'comment',
        actor: comment.author.kind,
        at: comment.createdAt,
        summary: comment.body,
        commentId: comment.id,
      })
    for (const q of issue.discussion.questions) {
      issue.timeline.push({
        id: `question:${q.id}`,
        kind: 'question',
        actor: 'user',
        at: q.at,
        summary: q.question,
      })
      if (q.answer)
        issue.timeline.push({
          id: `answer:${q.id}`,
          kind: 'answer',
          actor: q.mode === 'manager' ? 'manager' : 'question',
          at: q.answeredAt ?? q.at,
          summary: q.answer,
        })
    }
    for (const change of [
      ...this.store.changes(managerId),
      ...this.store.issueChanges(managerId),
    ].filter((c) => String(c.objectId) === id)) {
      if (!change.before) continue
      issue.timeline.push({
        id: `change:${change.id}`,
        changeId: change.id,
        kind: change.fields.includes('status')
          ? 'status'
          : change.fields.includes('readRevision')
            ? 'read'
            : change.fields.includes('followUp')
              ? 'followUp'
              : 'edited',
        actor: change.by === 'user-conversation' ? 'user' : change.by,
        at: change.at,
        summary: change.why,
      })
    }
    if (id.startsWith('S-')) {
      const review = this.store.suggestionReview(managerId, id.slice(2))
      if (review?.at !== null && review?.at !== undefined)
        issue.timeline.push({
          id: `review:${id}:${review.at}`,
          kind: 'status',
          actor: 'manager',
          at: review.at,
          summary: review.reason ?? review.state,
        })
      const proposal = this.owner.tree.store.proposal(id.slice(2))
      if (proposal?.settledAt)
        issue.timeline.push({
          id: `settled:${id}:${proposal.settledAt}`,
          kind: 'status',
          actor: 'device',
          at: proposal.settledAt,
          summary: proposal.status,
        })
    }
    for (const r of issue.relations)
      issue.timeline.push({
        id: `relation:${r.id}`,
        kind: 'relation',
        actor: r.by === 'projection' ? 'device' : r.by,
        at: r.at,
        summary: `${r.from.target} → ${r.to.target}`,
      })
    issue.timeline.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    return issue
  }
  list(managerId: string, query: ManagerIssueQuery): ManagerIssuePage {
    const kinds = query.kinds ?? ['ordinary']
    const ids = [
      ...this.store.issues(managerId).map((i) => (i as ManagerIssue).id),
      ...this.store
        .objects(managerId)
        .filter((o) => !o.id.startsWith('I-'))
        .map((o) => o.id),
      ...this.store.publishedReports(managerId).map((r) => r.id),
      ...this.owner.paging.suggestions(managerId).map((p) => p.id),
    ]
    let issues = [...new Set(ids)]
      .map((id) => this.get(managerId, id, false))
      .filter(
        (i) =>
          kinds.includes(i.kind) &&
          (!query.discussionsOnly || i.kind === 'ordinary' || i.discussion.opened === true) &&
          (!query.statuses?.length || query.statuses.includes(i.status)) &&
          (!query.authors?.length || query.authors.includes(i.author.kind)) &&
          (!query.followUp || query.followUp === 'all' || query.followUp === i.followUp.state) &&
          (query.unread === undefined || query.unread === i.unread),
      )
    issues.sort(
      (a, b) =>
        (query.order === 'pending' ? Number(pending(b)) - Number(pending(a)) : 0) ||
        (query.order === 'oldest'
          ? a.createdAt - b.createdAt
          : query.order === 'updated'
            ? b.updatedAt - a.updatedAt
            : b.createdAt - a.createdAt) ||
        b.id.localeCompare(a.id, 'en', { numeric: true }),
    )
    const offset = query.cursor ? Number(query.cursor) : 0
    const limit = query.limit ?? 30
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      invalid('Invalid issue page cursor or limit.')
    const total = issues.length
    issues = issues.slice(offset, offset + limit)
    return {
      query,
      total,
      nextCursor: offset + limit < total ? String(offset + limit) : null,
      entries: issues.map((i) => ({
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
  private event(
    managerId: string,
    issue: ManagerIssue,
    actor: ManagerIssueAuthorKind,
    kind: ManagerIssueActivityNotification['kind'],
    comment?: ManagerIssueComment,
  ): ManagerIssueActivityNotification {
    const event: ManagerIssueActivityNotification = {
      managerId,
      issueId: issue.id,
      eventId: randomUUID(),
      kind,
      actor,
      followUp: issue.followUp.state,
      unread: actor === 'manager',
    }
    this.store.saveIssueNotification(
      managerId,
      event.eventId,
      issue.id,
      actor === 'manager' ? 'user' : 'manager',
      JSON.stringify(event),
    )
    if (actor === 'user' && issue.followUp.state === 'on') {
      this.store.enqueue(
        managerId,
        formatSessionEvent({
          kind: 'manager-issue',
          notes: [],
          manager: {
            managerId,
            text:
              JSON.stringify({
                ...event,
                title: issue.title,
                revision: issue.revision,
                ...(comment ? { commentId: comment.id, body: comment.body } : { body: issue.body }),
              }) +
              '\nRead issue_get before responding. Comments are discussion, not decision answers or delivery.',
          },
        }),
      )
    }
    return event
  }
  private broadcast(
    managerId: string,
    issue: ManagerIssue,
    change: ManagerIssueChangedNotification['change'],
    event?: ManagerIssueActivityNotification,
  ): void {
    this.owner.tree.host.announce(
      NOTICE.changed,
      { managerId, issueId: issue.id, revision: issue.revision, change },
      EXTENSION.managerIssues,
    )
    if (event) this.owner.tree.host.announce(NOTICE.activity, event, EXTENSION.managerIssues)
    if (event?.actor === 'user' && event.followUp === 'on') this.owner.kick(managerId)
  }
  private links(
    managerId: string,
    issueId: string,
    params: Record<string, unknown>,
    actor: ManagerIssueAuthorKind,
  ): void {
    addRelations(
      this.store,
      managerId,
      issueId,
      params,
      (id) => this.owner.lines.mark(id)?.managerId === managerId,
      (id) =>
        this.owner.lines.mark(this.owner.tree.store.proposal(id)?.threadId ?? '')?.managerId ===
        managerId,
      actor,
    )
  }
  call(method: string, given: unknown, actor: ManagerIssueAuthorKind = 'user'): unknown {
    const p = fields(given)
    const managerId = text(p.managerId, 'managerId')
    if (!this.store.manager(managerId)) fail('unknownManager', 'This manager does not exist.')
    if (method === METHOD.list) {
      keys(p, [
        'managerId',
        'kinds',
        'discussionsOnly',
        'statuses',
        'authors',
        'followUp',
        'unread',
        'order',
        'cursor',
        'limit',
      ])
      for (const field of ['kinds', 'statuses', 'authors'])
        if (
          p[field] !== undefined &&
          (!Array.isArray(p[field]) || !(p[field] as unknown[]).every((v) => typeof v === 'string'))
        )
          invalid(`Invalid ${field}.`)
      const accepted: Record<string, readonly string[]> = {
        kinds: ['ordinary', 'decision', 'suggestion', 'request', 'report'],
        authors: ['user', 'manager'],
        statuses: [
          'open',
          'in_progress',
          'blocked',
          'resolved',
          'closed',
          'answered',
          'expired',
          'withdrawn',
          'ignored',
          'pending',
          'endorsed',
          'started',
          'dismissed',
          'delivered',
          'replied',
          'cancelled',
          'unread',
          'read',
        ],
      }
      for (const [field, allowed] of Object.entries(accepted))
        if (
          Array.isArray(p[field]) &&
          (p[field] as string[]).some((value) => !allowed.includes(value))
        )
          invalid(`Invalid ${field}.`)
      if (p.followUp !== undefined && !['on', 'off', 'all'].includes(String(p.followUp)))
        invalid('Invalid followUp.')
      if (p.discussionsOnly !== undefined && typeof p.discussionsOnly !== 'boolean')
        invalid('discussionsOnly must be a boolean.')
      if (p.unread !== undefined && typeof p.unread !== 'boolean')
        invalid('unread must be a boolean.')
      if (
        p.order !== undefined &&
        !['newest', 'oldest', 'pending', 'updated'].includes(String(p.order))
      )
        invalid('Invalid issue order.')
      return {
        page: this.list(managerId, {
          ...p,
          order: p.order ?? 'newest',
        } as unknown as ManagerIssueQuery),
      }
    }
    if (method === METHOD.read) {
      keys(p, ['managerId', 'id'])
      return { issue: this.get(managerId, text(p.id, 'id')) }
    }
    // 用户评论仍可保存到已结束经理；事件保持待投递，drain 不再启动它。
    if (actor === 'manager') this.owner.writer.active(managerId)
    const key =
      p.idempotencyKey === undefined ? undefined : text(p.idempotencyKey, 'idempotencyKey')
    const signature = JSON.stringify(
      Object.fromEntries(
        Object.entries(p)
          .filter(([key]) => key !== 'idempotencyKey')
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    if (key) {
      const saved = this.store.idempotency(managerId, `${actor}:${method}:${key}`, method) as {
        signature: string
        response: unknown
      } | null
      if (saved) {
        if (saved.signature !== signature)
          fail(
            'issueIdempotencyConflict',
            'This idempotency key was already used for different content.',
          )
        return saved.response
      }
    }
    let event: ManagerIssueActivityNotification | undefined
    let change: ManagerIssueChangedNotification['change'] = 'updated'
    let issue: ManagerIssue
    if (method === METHOD.create) {
      keys(p, ['managerId', 'title', 'body', 'source', 'related', 'followUp', 'idempotencyKey'])
      const title = text(p.title, 'title')
      const body = text(p.body, 'body', false)
      const follow = p.followUp ?? 'on'
      if (follow !== 'on' && follow !== 'off') invalid('Invalid followUp.')
      issue = this.store.transaction(() => {
        const at = managerNow()
        const created: ManagerIssue = {
          id: this.store.nextIssueId(managerId),
          kind: 'ordinary',
          title,
          body,
          status: 'open',
          stateGroup: 'open',
          author: { kind: actor },
          revision: 1,
          createdAt: at,
          updatedAt: at,
          followUp: { state: follow, changedAt: at, changedBy: actor },
          discussion: { comments: [], questions: [], summary: null },
          relations: [],
          timeline: [],
          quick: {},
          unread: actor === 'manager',
        }
        // unread 的权威是 notifications；正文不留永久 true。
        this.store.saveIssue(managerId, created.id, { ...created, unread: false })
        this.links(managerId, created.id, p, actor)
        this.store.recordIssue(managerId, created.id, actor, null, created, 'Issue created')
        event = this.event(managerId, created, actor, 'issue-created')
        const result = this.get(managerId, created.id)
        if (key)
          this.store.saveIdempotency(managerId, `${actor}:${method}:${key}`, method, {
            signature,
            response: { issue: result },
          })
        return result
      })
      change = 'created'
    } else if (method === METHOD.seen) {
      keys(p, ['managerId', 'id', 'revision'])
      // 已读不改正文版本。重复确认不写库、不广播，避免每次都让所有客户端重读整板。
      const before = this.get(managerId, text(p.id, 'id'), false)
      if (p.revision !== before.revision)
        fail(
          'issueConflict',
          'The issue changed; read issue_get and retry with its current revision.',
        )
      const changed = before.unread && this.store.markIssueSeen(managerId, before.id, managerNow())
      const issue = this.get(managerId, before.id)
      if (changed) this.broadcast(managerId, issue, 'read')
      return { issue }
    } else {
      const before = this.get(managerId, text(p.id, 'id'))
      if (p.revision !== before.revision)
        fail(
          'issueConflict',
          'The issue changed; read issue_get and retry with its current revision.',
        )
      issue = this.store.transaction(() => {
        const at = managerNow()
        const meta = (this.store.issueMeta(managerId, before.id) as Meta | null) ?? {
          revision: 0,
          updatedAt: before.updatedAt,
        }
        if (method === METHOD.comment) {
          keys(p, [
            'managerId',
            'id',
            'revision',
            'body',
            'replyTo',
            'idempotencyKey',
            'why',
            'commentId',
            'commentRevision',
          ])
          const body = text(p.body, 'body')
          const previous =
            p.commentId === undefined
              ? undefined
              : before.discussion.comments.find((c) => c.id === p.commentId)
          if (p.commentId !== undefined || p.commentRevision !== undefined) {
            if (!previous) fail('unknownComment', 'The comment does not belong to this issue.')
            if (previous!.author.kind !== actor)
              fail('issueForbidden', 'You may edit only your own comments.')
            if (previous!.revision !== p.commentRevision)
              fail('issueCommentConflict', 'The comment changed; read it again.')
          }
          if (
            p.replyTo !== undefined &&
            p.replyTo !== null &&
            !before.discussion.comments.some((c) => c.id === p.replyTo)
          )
            fail('unknownComment', 'Reply comment does not belong to this issue.')
          const comment: ManagerIssueComment = {
            id: previous?.id ?? randomUUID(),
            revision: (previous?.revision ?? 0) + 1,
            author: { kind: actor },
            body,
            replyTo: previous?.replyTo ?? (typeof p.replyTo === 'string' ? p.replyTo : null),
            createdAt: previous?.createdAt ?? at,
            updatedAt: at,
          }
          this.store.saveIssueComment(managerId, before.id, comment.id, comment)
          this.store.saveIssueMeta(managerId, before.id, { ...meta, updatedAt: at })
          this.store.recordIssue(
            managerId,
            before.id,
            actor,
            previous ?? null,
            { commentId: comment.id, body, revision: comment.revision },
            typeof p.why === 'string' ? p.why : previous ? 'Comment edited' : 'Comment added',
          )
          event = this.event(managerId, before, actor, 'issue-comment', comment)
          change = 'commented'
        } else {
          let patch: Record<string, unknown> = {}
          if (method === METHOD.follow) {
            keys(p, ['managerId', 'id', 'revision', 'state', 'why'])
            patch = { followUp: p.state }
          } else if (method === METHOD.update) {
            keys(p, ['managerId', 'id', 'revision', 'patch', 'why'])
            patch = fields(p.patch)
            keys(patch, [
              'title',
              'body',
              'status',
              'followUp',
              'source',
              'related',
              'discussionOpened',
            ])
            if (
              before.kind !== 'ordinary' &&
              Object.keys(patch).some((key) => key !== 'discussionOpened')
            )
              fail(
                'issueTypeMismatch',
                'Use the special issue quick actions or post_reply to edit this issue.',
              )
          } else fail('methodNotFound', `Unknown issue method: ${method}`)
          const why =
            p.why === undefined && actor === 'user' ? 'Follow-up updated' : text(p.why, 'why')
          if (patch.followUp !== undefined && patch.followUp !== 'on' && patch.followUp !== 'off')
            invalid('Invalid followUp.')
          if (
            patch.status !== undefined &&
            !['open', 'in_progress', 'blocked', 'resolved', 'closed'].includes(String(patch.status))
          )
            invalid('Invalid issue status.')
          if (patch.discussionOpened !== undefined && patch.discussionOpened !== true)
            invalid('discussionOpened can only be true.')
          if (patch.discussionOpened === true) meta.discussionOpened = true
          const after = {
            ...before,
            discussion: {
              ...before.discussion,
              ...(meta.discussionOpened ? { opened: true } : {}),
            },
          }
          if (patch.title !== undefined) after.title = text(patch.title, 'title')
          if (patch.body !== undefined) after.body = text(patch.body, 'body', false)
          if (patch.status !== undefined) after.status = patch.status as ManagerIssue['status']
          if (patch.followUp !== undefined)
            meta.followUp = {
              state: patch.followUp as 'on' | 'off',
              changedAt: at,
              changedBy: actor,
            }
          if (before.kind === 'ordinary') {
            const raw = this.store.issue(managerId, before.id) as ManagerIssue
            this.store.saveIssue(managerId, before.id, {
              ...raw,
              title: after.title,
              body: after.body,
              status: after.status,
            })
          }
          this.store.saveIssueMeta(managerId, before.id, {
            ...meta,
            revision: meta.revision + 1,
            updatedAt: at,
          })
          this.links(managerId, before.id, patch, actor)
          this.store.recordIssue(
            managerId,
            before.id,
            actor,
            before,
            {
              ...after,
              ...(meta.followUp ? { followUp: meta.followUp } : {}),
              revision: before.revision + 1,
            },
            why,
          )
          change =
            patch.followUp !== undefined
              ? 'followUp'
              : patch.status !== undefined
                ? 'status'
                : 'updated'
          if (actor === 'manager')
            event = this.event(
              managerId,
              this.get(managerId, before.id, false),
              actor,
              'issue-updated',
            )
        }
        const result = this.get(managerId, before.id)
        if (key)
          this.store.saveIdempotency(managerId, `${actor}:${method}:${key}`, method, {
            signature,
            response: { issue: result },
          })
        return result
      })
    }
    this.broadcast(managerId, issue, change, event)
    return { issue }
  }
}
