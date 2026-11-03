// 原帖从权威对象投影；报告独立持久化。讨论、编辑和已阅均校验当前版本。
import { randomUUID } from 'node:crypto'
import type { ManagerActor, ManagerChange, ManagerDiscussion } from '../../protocol/src/manager.mjs'
import type {
  ManagerPost,
  ManagerPostId,
  ManagerReport,
} from '../../protocol/src/manager-posts.mjs'
import { formatSessionEvent } from '../../protocol/src/session-tree.mjs'
import type { DeviceManagers } from './manager.mjs'
import { isDecision } from './manager-board.mjs'
import { addRelations } from './manager-relations.mjs'
import { isRequest } from './manager-requests.mjs'
import { managerNow, type QuestionState } from './manager-store.mjs'
import { fields, invalid, keys, text, validateTool } from './manager-validate.mjs'

const empty = (): ManagerDiscussion => ({ messages: [], light: false, summary: null, forwarded: 0 })
export class ManagerPosts {
  readonly owner: DeviceManagers
  constructor(owner: DeviceManagers) {
    this.owner = owner
  }
  private get store() {
    return this.owner.store
  }
  list(managerId: string, changes = this.store.changes(managerId)): ManagerPost[] {
    // 一次看板读取只解析一次历史，再按对象分组；不能让每张帖子重读整份历史。
    const histories = new Map<string, ManagerChange[]>()
    for (const change of changes) {
      const history = histories.get(change.objectId) ?? []
      history.push(change)
      histories.set(change.objectId, history)
    }
    const ids: ManagerPostId[] = this.store
      .objects(managerId)
      .filter((o) => isDecision(o) || isRequest(o))
      .map((o) => o.id as ManagerPostId)
    ids.push(...this.store.publishedReports(managerId).map((r) => r.id))
    for (const proposal of this.owner.tree.store.allSuggestions())
      if (
        !proposal.offer &&
        (this.owner.store.historical(proposal.threadId)?.id ??
          this.owner.lines.mark(proposal.threadId)?.managerId) === managerId
      )
        ids.push(`S-${proposal.id}`)
    // 已了结建议仍可读既有讨论，历史不因卡片开始或忽略而消失。
    for (const state of this.store.questions(managerId))
      if (!ids.includes(state.decisionId)) ids.push(state.decisionId)
    return ids.flatMap((id) => {
      try {
        return [this.project(managerId, id, histories.get(id) ?? [])]
      } catch {
        return []
      }
    })
  }
  get(managerId: string, id: string): ManagerPost {
    return this.project(managerId, id, this.store.changes(managerId))
  }
  private project(managerId: string, id: string, changes: ManagerChange[]): ManagerPost {
    let original: Omit<ManagerPost, 'discussion' | 'versions'>
    if (id.startsWith('P-')) {
      const report = this.store.publishedReports(managerId).find((r) => r.id === id)
      if (!report) invalid('Unknown report.')
      original = {
        ...report,
        kind: 'report',
        unread: report.readRevision !== report.revision,
        fields: { title: report.title, body: report.body },
      }
    } else if (id.startsWith('S-')) {
      const proposal = this.owner.tree.store.proposal(id.slice(2))
      if (
        !proposal ||
        proposal.offer ||
        (this.owner.store.historical(proposal.threadId)?.id ??
          this.owner.lines.mark(proposal.threadId)?.managerId) !== managerId
      )
        invalid('This suggestion does not belong to this manager.')
      const version = this.store.suggestionVersion(managerId, id)
      original = {
        id: id as ManagerPostId,
        kind: 'suggestion',
        title: proposal.title,
        body: proposal.prompt,
        revision: version?.revision ?? 1,
        createdAt: proposal.createdAt,
        updatedAt: version?.updatedAt ?? proposal.createdAt,
        proposalId: proposal.id,
        sourceThreadId: proposal.threadId,
        fields: { title: proposal.title, body: proposal.prompt, status: proposal.status },
      }
    } else {
      const obj = this.owner.writer.object(managerId, id)
      if (!isDecision(obj) && !isRequest(obj))
        invalid('Progress items do not accept user discussions.')
      original = {
        id: obj.id,
        kind: isDecision(obj) ? 'decision' : 'request',
        title: obj.title,
        body: isDecision(obj) ? obj.background : obj.description,
        revision: obj.revision,
        createdAt: obj.createdAt,
        updatedAt: obj.updatedAt,
        fields: isDecision(obj)
          ? {
              title: obj.title,
              body: obj.background,
              options: obj.options,
              recommend: obj.recommend,
            }
          : { title: obj.title, body: obj.description, buttonLabel: obj.buttonLabel },
      }
    }
    const versions = changes
      .filter(
        (c) =>
          c.objectId === id &&
          c.before &&
          c.fields.some((f) =>
            [
              'title',
              'body',
              'background',
              'description',
              'options',
              'recommend',
              'buttonLabel',
              'prompt',
            ].includes(f),
          ),
      )
      .map((c) => ({
        revision: Number(c.before?.revision ?? 1),
        title: String(c.before?.title ?? ''),
        body: String(
          c.before?.body ?? c.before?.background ?? c.before?.description ?? c.before?.prompt ?? '',
        ),
        at: c.at,
        by: c.by,
        why: c.why,
      }))
    return {
      ...original,
      author: { kind: 'manager' },
      versions,
      discussion: this.store.question(managerId, id)?.discussion ?? empty(),
    }
  }
  tool(
    managerId: string,
    tool: 'report' | 'post_get' | 'post_reply',
    given: unknown,
    actor?: ManagerActor,
  ): { post: ManagerPost }
  tool(
    managerId: string,
    tool: string,
    given: unknown,
    actor?: ManagerActor,
  ): {
    post?: ManagerPost
    relations?: import('../../protocol/src/manager-posts.mjs').ManagerRelation[]
  }
  tool(managerId: string, tool: string, given: unknown, actor: ManagerActor = 'manager') {
    const args = validateTool(tool, given)
    if (tool === 'post_get') return { post: this.get(managerId, text(args.id, 'id')) }
    this.owner.writer.active(managerId)
    if (tool === 'relate') {
      if (![args.source, args.related].some((value) => Array.isArray(value) && value.length))
        invalid('Provide at least one source or related target.')
      const id = text(args.id, 'id')
      if (!id.startsWith('I-')) this.get(managerId, id)
      else this.owner.writer.object(managerId, id)
      const relations = this.store.transaction(() =>
        addRelations(
          this.store,
          managerId,
          id,
          args,
          (threadId) => this.owner.lines.mark(threadId)?.managerId === managerId,
          (proposalId) => {
            const p = this.owner.tree.store.proposal(proposalId)
            return !!p && this.owner.lines.mark(p.threadId)?.managerId === managerId
          },
        ),
      )
      return { relations }
    }
    if (tool === 'report') {
      const report = this.store.transaction(() => {
        const at = managerNow()
        const report: ManagerReport = {
          id: this.store.nextId(managerId, 'P') as `P-${number}`,
          title: text(args.title, 'title'),
          body: text(args.body, 'body'),
          revision: 1,
          readRevision: 0,
          createdAt: at,
          updatedAt: at,
        }
        this.store.savePublishedReport(managerId, report)
        addRelations(
          this.store,
          managerId,
          report.id,
          args,
          (threadId) => this.owner.lines.mark(threadId)?.managerId === managerId,
          (proposalId) => {
            const p = this.owner.tree.store.proposal(proposalId)
            return !!p && this.owner.lines.mark(p.threadId)?.managerId === managerId
          },
        )
        this.store.record(managerId, report.id, actor, null, report, text(args.why, 'why'))
        return report
      })
      return { post: this.get(managerId, report.id) }
    }
    const before = this.get(managerId, text(args.id, 'id'))
    if (before.revision !== args.revision)
      invalid('The post changed; read post_get and retry with its current revision.')
    const patch = args.patch === undefined ? {} : fields(args.patch)
    const reply = args.text === undefined ? '' : text(args.text, 'text')
    const why = text(args.why, 'why')
    if (!Object.keys(patch).length && !reply) invalid('Supply a patch, a reply, or both.')
    const state = this.store.question(managerId, before.id)
    if (
      args.questionId &&
      !state?.discussion.messages.some(
        (q) => q.id === args.questionId && q.mode === 'manager' && q.status === 'running',
      )
    )
      invalid('The pending question does not exist.')
    if (Object.keys(patch).length) {
      keys(
        patch,
        before.kind === 'decision'
          ? ['title', 'body', 'options', 'recommend']
          : before.kind === 'request'
            ? ['title', 'body', 'buttonLabel']
            : ['title', 'body'],
      )
      if ('title' in patch) text(patch.title, 'title')
      if ('body' in patch) text(patch.body, 'body')
      if (before.kind === 'suggestion') {
        if (this.owner.tree.accepting.has(before.proposalId ?? ''))
          invalid('This suggestion is already starting.')
        if (
          !this.owner.tree.store.editSuggestion(
            before.proposalId ?? '',
            String(patch.title ?? before.title),
            String(patch.body ?? before.body),
          )
        )
          invalid('Only a pending suggestion can be edited.')
        this.store.transaction(() => {
          this.store.saveSuggestionVersion(managerId, before.id, before.revision + 1)
          this.store.record(
            managerId,
            before.id,
            actor,
            before,
            { ...before, ...patch, revision: before.revision + 1 },
            why,
          )
        })
        const proposal = this.owner.tree.store.proposal(before.proposalId ?? '')
        if (proposal) this.owner.tree.proposalsChanged(proposal.threadId, [proposal])
      } else if (before.kind === 'report') {
        const report = this.store.publishedReports(managerId).find((r) => r.id === before.id)
        if (!report) invalid('Unknown report.')
        this.store.transaction(() => {
          const after = {
            ...report,
            ...patch,
            revision: report.revision + 1,
            updatedAt: managerNow(),
          } as ManagerReport
          this.store.savePublishedReport(managerId, after)
          this.store.record(managerId, before.id, actor, report, after, why)
        })
      } else {
        const { body, ...rest } = patch
        this.owner.writer.tool(
          managerId,
          'update',
          {
            kind: before.kind,
            id: before.id,
            ...(before.kind === 'request' ? { revision: before.revision } : {}),
            patch: {
              ...rest,
              ...(body === undefined
                ? {}
                : { [before.kind === 'decision' ? 'background' : 'description']: body }),
            },
            why,
          },
          undefined,
          actor,
        )
      }
    }
    if (actor === 'manager') {
      const current: QuestionState = state ?? {
        managerId,
        decisionId: before.id,
        threadId: null,
        threads: [],
        source: '',
        revision: 0,
        discussion: empty(),
      }
      const pending = current.discussion.messages.filter(
        (q) =>
          q.mode === 'manager' &&
          q.status === 'running' &&
          (!args.questionId || q.id === args.questionId),
      )
      for (const q of pending) {
        q.answer = reply || null
        q.updatedPost = Object.keys(patch).length > 0
        q.answeredAt = managerNow()
        q.status = 'completed'
      }
      if (!pending.length && reply)
        current.discussion.messages.push({
          id: randomUUID(),
          mode: 'manager',
          question: '',
          answer: reply,
          status: 'completed',
          refreshed: false,
          at: managerNow(),
          answeredAt: managerNow(),
        })
      this.store.saveQuestion(current)
    }
    return { post: this.get(managerId, before.id) }
  }
  ask(managerId: string, id: ManagerPostId, revision: number, question: string) {
    this.owner.writer.active(managerId)
    const post = this.get(managerId, id)
    if (post.revision !== revision) invalid('The post changed. Review it before asking.')
    if (!question.trim() || question.length > 20000) invalid('Invalid question.')
    const state: QuestionState = this.store.question(managerId, id) ?? {
      managerId,
      decisionId: id,
      threadId: null,
      threads: [],
      source: '',
      revision: 0,
      discussion: empty(),
    }
    if (state.discussion.messages.some((q) => q.mode !== 'manager' && q.status === 'running'))
      invalid('A temporary reply is still running.')
    state.discussion.messages.push({
      id: randomUUID(),
      mode: 'manager',
      question,
      answer: null,
      status: 'running',
      refreshed: false,
      at: managerNow(),
    })
    this.store.transaction(() => {
      this.store.saveQuestion(state)
      this.store.enqueue(
        managerId,
        formatSessionEvent({
          kind: 'manager-answers',
          notes: [],
          manager: {
            managerId,
            answers: [],
            postQuestions: [{ id, revision, title: post.title, question }],
            text: 'Read litch_manager.post_get and use post_reply to update the original, append a reply, or both. This question is not authorization to act.',
          },
        }),
      )
    })
    this.owner.changed(managerId)
    this.owner.kick(managerId)
    return { post: this.get(managerId, id) }
  }
  read(managerId: string, id: string, revision: number) {
    this.owner.writer.active(managerId)
    const report = this.store.publishedReports(managerId).find((r) => r.id === id)
    if (!report || report.revision !== revision)
      invalid('The report changed; read the latest revision before marking it read.')
    this.store.savePublishedReport(managerId, { ...report, readRevision: revision })
    this.owner.changed(managerId)
    return { post: this.get(managerId, id) }
  }
}
