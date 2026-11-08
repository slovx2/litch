import { execFile } from 'node:child_process'
// litchManager 的设备入口：建会话、读看板、投递持久事件，以及只向声明过的连接广播。
import { createHash, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { type ClientToolCallResponse, clientToolFailure } from '../../protocol/src/client-tools.mjs'
import {
  managerEndText,
  managerOpenText,
  managerRulesText,
} from '../../protocol/src/client-tools-manager.mjs'
import { ruledNamespaces } from '../../protocol/src/codex-developer-instructions.mjs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  MANAGER_METHOD,
  MANAGER_NOTIFICATION,
  type Manager,
  type ManagerActivity,
  type ManagerBoard,
  type ManagerObjectId,
} from '../../protocol/src/manager.mjs'
import { MANAGER_ISSUE_METHOD } from '../../protocol/src/manager-issues.mjs'
import { MANAGER_PAGING_METHOD } from '../../protocol/src/manager-paging.mjs'
import { MANAGER_POST_METHOD, type ManagerPostId } from '../../protocol/src/manager-posts.mjs'
import {
  formatSessionEvent,
  parseSessionEvent,
  type SessionProposal,
} from '../../protocol/src/session-tree.mjs'
import { proposalSummary, shortObjectId } from '../../protocol/src/suggestion-summary.mjs'
import type { DeviceToolCall } from './device-tools.mjs'
import { isDecision, ManagerBoardWriter } from './manager-board.mjs'
import { validateManagerRuntime } from './manager-create-validation.mjs'
import { ManagerEndings } from './manager-ending.mjs'
import { submitManagerFeedback } from './manager-feedback.mjs'
import { ManagerIssues } from './manager-issues.mjs'
import { ManagerLines } from './manager-lines.mjs'
import { ManagerPaging } from './manager-paging.mjs'
import { ManagerPosts } from './manager-posts.mjs'
import { ManagerQuestions } from './manager-questions.mjs'
import { projectedRelations } from './manager-relations.mjs'
import { isRequest } from './manager-requests.mjs'
import { ManagerResets } from './manager-reset.mjs'
import { managerBundle, managerFingerprint, managerTools } from './manager-rules.mjs'
import { ManagerStore, managerNow, openManagerDatabase } from './manager-store.mjs'
import {
  fields,
  invalidSetting,
  keys,
  ManagerError,
  text,
  validateCreate,
  validatePatch,
  validateTool,
} from './manager-validate.mjs'
import { requireSupportedPermission, supportedPermissions } from './session-permissions.mjs'
import type { SessionTree } from './session-tree.mjs'
import { DeviceError, isObject } from './wire.mjs'

export class DeviceManagers {
  readonly store: ManagerStore
  readonly lines: ManagerLines
  readonly endings: ManagerEndings
  readonly writer: ManagerBoardWriter
  readonly posts: ManagerPosts
  readonly issues: ManagerIssues
  readonly questions: ManagerQuestions
  readonly resets: ManagerResets
  readonly paging: ManagerPaging
  private readonly draining = new Map<string, Promise<void>>()
  /** 先持久入队，再留一个固定的小窗口合并连发卡片；不会因持续提卡无限延后。 */
  private readonly suggestionTimers = new Map<string, NodeJS.Timeout>()
  private readonly timer: NodeJS.Timeout
  private closed = false
  private readonly unlisten: () => void
  readonly tree: SessionTree
  readonly born: (harness: string, thread: Record<string, unknown>) => void
  constructor(
    tree: SessionTree,
    stateDir: string,
    born: (harness: string, thread: Record<string, unknown>) => void = () => {},
  ) {
    this.tree = tree
    this.born = born
    this.store = new ManagerStore(openManagerDatabase(stateDir))
    this.lines = new ManagerLines(this.store, tree)
    this.endings = new ManagerEndings(this.store, tree, (id) => this.changed(id))
    this.writer = new ManagerBoardWriter(
      this.store,
      (managerId, threadId) =>
        this.lines.mark(threadId)?.managerId === managerId &&
        this.lines.mark(threadId)?.role === 'line',
      (managerId, id) => {
        const proposal = this.tree.store.proposal(id)
        return !!proposal && this.lines.mark(proposal.threadId)?.managerId === managerId
      },
    )
    this.posts = new ManagerPosts(this)
    this.questions = new ManagerQuestions(this)
    this.resets = new ManagerResets(this)
    this.paging = new ManagerPaging(this)
    this.issues = new ManagerIssues(this)
    this.unlisten = tree.onTurnEnded((threadId) => {
      const manager = this.lines.managerFor(threadId)
      if (manager) {
        this.resets.tick(manager.id)
        this.changed(manager.id)
        this.kick(manager.id)
      }
    })
    this.timer = setInterval(() => {
      for (const manager of this.store.managers()) this.resets.tick(manager.id)
      for (const id of new Set([
        ...this.store.deliveries().map((event) => event.managerId),
        ...this.store
          .managers()
          .filter((manager) => manager.status === 'ending')
          .map((manager) => manager.id),
      ]))
        this.kick(id)
    }, 1000)
    this.timer.unref()
    // 持久化的 waiting 不依赖客户端重订阅；构造完成即可续做。
    queueMicrotask(() => {
      if (this.closed) return
      for (const manager of this.store.managers()) this.resets.tick(manager.id)
    })
  }
  manager(id: string): Manager {
    const manager = this.store.manager(id)
    if (!manager) throw new ManagerError('unknownManager', 'This manager does not exist.')
    const board = this.board(id)
    return {
      ...manager,
      reset: this.resets.state(manager),
      historyThreadIds: this.store.history(id),
      pendingDecisions: board.decisions.filter((decision) => decision.status === 'open').length,
      pendingRequests: (board.requests ?? []).filter((request) => request.status === 'open').length,
      pendingReports:
        board.posts?.filter((post) => post.kind === 'report' && post.unread).length ?? 0,
      pendingSuggestions: (board.posts ?? []).filter(
        (post) => post.kind === 'suggestion' && post.fields.status === 'pending',
      ).length,
      runningLines: board.lines.filter((line) => line.running).length,
      latestActivity: board.activities[0] ?? null,
      updatedAt: Math.max(manager.updatedAt, board.activities[0]?.at ?? 0),
    }
  }
  board(id: string): ManagerBoard {
    if (!this.store.manager(id))
      throw new ManagerError('unknownManager', 'This manager does not exist.')
    const objects = this.store.objects(id)
    const changes = this.store.changes(id)
    const lines = this.lines.lines(id)
    const activities: ManagerActivity[] = changes.map((change) => ({
      id: change.id,
      source: {
        kind:
          change.by === 'manager'
            ? 'manager'
            : ['user', 'user-conversation'].includes(change.by)
              ? 'user'
              : 'system',
      },
      kind:
        change.objectId === 'manager'
          ? 'manager'
          : change.objectId === 'status'
            ? 'status'
            : change.objectId.startsWith('D-')
              ? 'decision'
              : change.objectId.startsWith('R-')
                ? 'request'
                : 'item',
      at: change.at,
      text: change.why,
      objectId:
        change.objectId === 'manager' || change.objectId === 'status' ? null : change.objectId,
      threadId: null,
      changeId: change.id,
    }))
    for (const line of lines)
      if (line.report)
        activities.push({
          id: `report:${line.threadId}:${this.store.report(line.threadId)?.turnId}`,
          kind: 'report',
          source: { kind: 'line', threadId: line.threadId, title: line.title },
          at: line.report.at,
          text: line.report.text,
          objectId: null,
          threadId: line.threadId,
          changeId: null,
        })
    activities.sort((a, b) => b.at - a.at)
    return {
      managerId: id,
      posts: this.posts.list(id, changes),
      relations: projectedRelations(this.store, id).filter(
        (r) => !r.from.target.startsWith('X-') && !r.to.target.startsWith('X-'),
      ),
      situation: this.store.situation(id),
      decisions: objects.filter(isDecision).map((decision) => {
        const state = this.store.question(id, decision.id)
        return state ? { ...decision, discussion: state.discussion } : decision
      }),
      items: objects.filter(
        (object): object is import('../../protocol/src/manager.mjs').ManagerItem =>
          !isDecision(object) && !isRequest(object),
      ),
      requests: objects.filter(isRequest),
      lines,
      activities,
      changes,
    }
  }
  changed(id: string): void {
    if (this.closed) return
    this.issues?.specialChanged(id)
    this.questions.releaseClosed(id)
    this.tree.host.announce(
      MANAGER_NOTIFICATION.changed,
      { manager: this.manager(id) },
      EXTENSION.manager,
    )
    this.tree.host.announce(MANAGER_NOTIFICATION.boardChanged, { managerId: id }, EXTENSION.manager)
  }
  decorate(thread: Record<string, unknown>): void {
    delete thread.litchManager
    if (typeof thread.id !== 'string') return
    const mark = this.lines.mark(thread.id)
    if (mark) thread.litchManager = mark
  }
  observe(method: string, params: Record<string, unknown>): void {
    if (this.closed) return
    if (
      ![
        'turn/started',
        'turn/completed',
        'thread/started',
        'thread/status/changed',
        'thread/name/updated',
        'thread/archived',
        'thread/unarchived',
      ].includes(method)
    )
      return
    this.lines.observe(method, params)
    const thread = isObject(params.thread) ? params.thread : null
    const threadId =
      typeof params.threadId === 'string'
        ? params.threadId
        : typeof thread?.id === 'string'
          ? thread.id
          : null
    if (!threadId) return
    const manager = this.lines.managerFor(threadId)
    if (!manager) return
    const name =
      typeof params.threadName === 'string'
        ? params.threadName
        : typeof thread?.name === 'string'
          ? thread.name
          : null
    if (manager.threadId === threadId && name !== null && name !== manager.name) {
      this.store.transaction(() => {
        const after = { ...manager, name, updatedAt: managerNow() }
        this.store.saveManager(after)
        this.store.record(manager.id, 'manager', 'device', manager, after, 'Thread renamed')
      })
    }
    this.changed(manager.id)
  }
  report(threadId: string, turnId: string, report: string, status: string): void {
    if (this.closed) return
    const mark = this.lines.mark(threadId)
    if (mark?.role !== 'line') return
    this.store.saveReport(threadId, { text: report, turnId, status, at: managerNow() })
    this.changed(mark.managerId)
  }
  async call(
    method: string,
    given: unknown,
    declared: boolean,
    pagingDeclared = false,
    issuesDeclared = false,
    issueDiscussionsDeclared = false,
  ): Promise<unknown> {
    if ((Object.values(MANAGER_ISSUE_METHOD) as string[]).includes(method)) {
      if (!issuesDeclared)
        throw new DeviceError('extensionRequired', `${method} requires litchManagerIssues.`, {
          required: [EXTENSION.managerIssues],
        })
      const params = fields(given)
      if (
        !issueDiscussionsDeclared &&
        ('discussionsOnly' in params ||
          (method === MANAGER_ISSUE_METHOD.update && 'discussionOpened' in fields(params.patch)))
      )
        throw new DeviceError(
          'extensionRequired',
          `${method} requires litchManagerIssueDiscussions.`,
          {
            required: [EXTENSION.managerIssueDiscussions],
          },
        )
      const result = this.issues.call(method, given)
      // 只有声明新能力的连接能收到开启标记；其它 issue 数据继续按原合同返回。
      if (!issueDiscussionsDeclared && result && typeof result === 'object' && 'issue' in result) {
        const issue = (
          result as { issue: import('../../protocol/src/manager-issues.mjs').ManagerIssue }
        ).issue
        const { opened: _opened, ...discussion } = issue.discussion
        return { ...result, issue: { ...issue, discussion } }
      }
      return result
    }
    if (!declared)
      throw new DeviceError(
        'extensionRequired',
        `${method} requires litchManager. Declare it in capabilities.litchExtensions.`,
        { method, required: [EXTENSION.manager] },
      )
    if (method === MANAGER_METHOD.create) return this.create(given)
    if ((Object.values(MANAGER_PAGING_METHOD) as string[]).includes(method)) {
      if (!pagingDeclared)
        throw new DeviceError('extensionRequired', `${method} requires litchManagerPaging.`, {
          method,
          required: [EXTENSION.managerPaging],
        })
      return this.paging.call(method, given)
    }
    const params = fields(given ?? {})
    if (method === MANAGER_METHOD.list) {
      keys(params, [])
      await Promise.all(this.store.managers().map((manager) => this.lines.refresh(manager.id)))
      return { managers: this.store.managers().map((manager) => this.manager(manager.id)) }
    }
    // 标准的“方法不存在”：客户端据此提示设备服务比应用旧，不当成参数错误或经理不存在
    if (!(Object.values(MANAGER_METHOD) as string[]).includes(method))
      throw new ManagerError('methodNotFound', `Unknown manager method: ${method}.`)
    const id = text(params.managerId, 'managerId')
    // 路由这里只校验身份。构造完整经理摘要会额外读取一次整板及历史。
    if (!this.store.manager(id))
      throw new ManagerError('unknownManager', 'This manager does not exist.')
    switch (method) {
      case MANAGER_METHOD.reset:
        keys(params, ['managerId', 'boardOnly'])
        this.resets.request(id, params.boardOnly === true)
        return { manager: this.manager(id) }
      case MANAGER_METHOD.resetCancel:
        keys(params, ['managerId'])
        this.resets.cancel(id)
        return { manager: this.manager(id) }
      case MANAGER_POST_METHOD.question: {
        keys(params, ['managerId', 'id', 'revision', 'question', 'mode'])
        const postId = text(params.id, 'id') as ManagerPostId
        const revision = typeof params.revision === 'number' ? params.revision : NaN
        const question = text(params.question, 'question')
        if (params.mode === 'manager') return this.posts.ask(id, postId, revision, question)
        if (params.mode !== 'temporary')
          throw new ManagerError('invalidManager', 'Invalid question mode.')
        await this.questions.ask(id, postId, revision, question)
        return { post: this.posts.get(id, postId) }
      }
      case MANAGER_POST_METHOD.reference: {
        keys(params, ['managerId', 'reference'])
        const reference = text(params.reference, 'reference')
        const cwd = this.store.manager(id)?.cwd
        const run = promisify(execFile)
        const options = {
          cwd,
          encoding: 'utf8' as const,
          timeout: 15000,
          maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        }
        const resolved = await run(
          'git',
          ['rev-parse', '--verify', '--end-of-options', `${reference}^{commit}`],
          options,
        )
        const sha = resolved.stdout.trim()
        if (!/^[0-9a-f]{40,64}$/.test(sha))
          throw new ManagerError('invalidManager', 'Invalid repository reference.')
        const shown = await run(
          'git',
          [
            '--no-pager',
            'show',
            '--no-ext-diff',
            '--no-textconv',
            '--format=fuller',
            '--stat',
            '--patch',
            sha,
            '--',
          ],
          options,
        )
        return { text: shown.stdout }
      }
      case MANAGER_POST_METHOD.forward:
        keys(params, ['managerId', 'id'])
        return this.questions.forward(id, text(params.id, 'id') as ManagerPostId)
      case MANAGER_POST_METHOD.read:
        keys(params, ['managerId', 'id', 'revision'])
        return this.posts.read(id, text(params.id, 'id'), Number(params.revision))
      case MANAGER_METHOD.questionAsk:
        keys(params, ['managerId', 'decisionId', 'revision', 'question'])
        return this.questions.ask(
          id,
          text(params.decisionId, 'decisionId') as `D-${number}`,
          typeof params.revision === 'number' ? params.revision : Number.NaN,
          text(params.question, 'question'),
        )
      case MANAGER_METHOD.questionForward:
        keys(params, ['managerId', 'decisionId'])
        return this.questions.forward(id, text(params.decisionId, 'decisionId') as `D-${number}`)
      case MANAGER_METHOD.boardRead:
        keys(params, ['managerId'])
        await this.lines.refresh(id)
        return { board: this.board(id) }
      case MANAGER_METHOD.update: {
        if (this.resets.held(this.store.manager(id)?.threadId ?? ''))
          throw new ManagerError(
            'invalidManager',
            'Wait for the manager reset to finish before changing settings.',
          )
        this.writer.active(id)
        const { managerId: _id, ...givenPatch } = params
        const patch = validatePatch(givenPatch)
        if (
          patch.dispatch?.harness &&
          !this.tree.host.harnesses().some((source) => source.id === patch.dispatch?.harness)
        )
          invalidSetting({
            field: 'dispatch.harness',
            reason: 'unavailableHarness',
            message: 'The default line harness is not configured.',
          })
        const before = this.store.manager(id) as Manager
        const after = { ...before, ...patch, updatedAt: managerNow() }
        this.store.transaction(() => {
          this.store.saveManager(after)
          this.store.record(id, 'manager', 'user', before, after, 'Manager settings updated')
          if (before.scope !== after.scope || before.rules !== after.rules)
            this.store.enqueue(
              id,
              formatSessionEvent({
                kind: 'manager-rules',
                notes: [],
                manager: { managerId: id, text: managerRulesText(after.scope, after.rules) },
              }),
            )
        })
        this.rememberRules(after)
        this.kick(id)
        if (patch.name !== undefined) {
          const link = await this.tree.link(after.harness)
          await link
            .request('thread/name/set', { threadId: after.threadId, name: after.name })
            .catch((error) =>
              this.tree.host.log(`经理名称已保存，引擎名称同步失败：${String(error)}`),
            )
        }
        this.changed(id)
        return { manager: this.manager(id) }
      }
      case MANAGER_METHOD.end: {
        if (this.resets.held(this.store.manager(id)?.threadId ?? ''))
          throw new ManagerError(
            'invalidManager',
            'Wait for the manager reset to finish before ending it.',
          )
        keys(params, ['managerId'])
        const before = this.store.manager(id) as Manager
        if (before.status === 'active') {
          this.store.transaction(() => {
            const after: Manager = {
              ...before,
              status: 'ending',
              endedAt: null,
              updatedAt: managerNow(),
            }
            this.store.saveManager(after)
            this.store.record(
              id,
              'manager',
              'user',
              before,
              after,
              'Manager finalization requested',
            )
            const message = formatSessionEvent({
              kind: 'manager-end',
              notes: [],
              manager: { managerId: id, text: managerEndText(before.template) },
            })
            const eventId = this.store.enqueue(id, message)
            this.store.beginEnding(id, eventId, message)
          })
          this.changed(id)
          this.kick(id)
        }
        return { manager: this.manager(id) }
      }
      case MANAGER_METHOD.feedbackSubmit: {
        keys(params, ['managerId', 'answers', 'questions', 'requests'])
        const result = submitManagerFeedback(
          this.writer,
          id,
          params.answers,
          params.questions,
          params.requests ?? [],
        )
        if (result.delivery === 'queued') {
          this.changed(id)
          this.kick(id)
        }
        return result
      }
      case MANAGER_METHOD.answersSubmit: {
        keys(params, ['managerId', 'answers'])
        const result = this.writer.answers(id, params.answers)
        if (result.accepted.length) {
          this.changed(id)
          this.kick(id)
        }
        return result
      }
      case MANAGER_METHOD.decisionIgnore: {
        keys(params, ['managerId', 'decisionId', 'revision', 'reason'])
        const decision = this.writer.ignore(
          id,
          text(params.decisionId, 'decisionId') as ManagerObjectId,
          params.revision,
          params.reason,
        )
        // 不唤醒：事件留在队列里，等经理有回合在跑或下一条开回合的事件（drain）
        this.changed(id)
        return { decision }
      }
      case MANAGER_METHOD.decisionReopen: {
        keys(params, ['managerId', 'decisionId'])
        const decision = this.writer.reopen(
          id,
          text(params.decisionId, 'decisionId') as ManagerObjectId,
        )
        this.changed(id)
        return { decision }
      }
      default:
        throw new ManagerError('methodNotFound', `Unknown manager method: ${method}.`)
    }
  }
  private async create(given: unknown): Promise<unknown> {
    const params = validateCreate(given)
    for (const [field, harness] of [
      ['harness', params.harness],
      ['dispatch.harness', params.dispatch.harness],
    ] as const)
      if (harness && !this.tree.host.harnesses().some((source) => source.id === harness))
        invalidSetting({
          field,
          reason: 'unavailableHarness',
          message: `Harness ${harness} is not configured.`,
        })
    const { firstTask, ...settings } = params
    await validateManagerRuntime(this.tree, params)
    const manager: Manager = {
      ...settings,
      id: randomUUID(),
      threadId: '',
      status: 'active',
      createdAt: managerNow(),
      updatedAt: managerNow(),
      endedAt: null,
      pendingDecisions: 0,
      runningLines: 0,
      latestActivity: null,
    }
    const link = await this.tree.link(params.harness)
    const remembered = this.tree.host.workspaces.permissions.read(
      params.cwd,
      params.harness,
    ).permission
    const permission =
      params.permission ??
      (supportedPermissions(link).includes(remembered ?? '') ? remembered : null)
    if (permission) {
      try {
        requireSupportedPermission(link, permission)
      } catch (error) {
        invalidSetting({
          field: 'permission',
          reason: 'unsupportedPermission',
          message: String(error),
        })
      }
      manager.permission = permission
    }
    const tools = managerBundle(manager, link.native, this.tree.host.taskCards(manager.harness))
    const created = await link.request('thread/start', {
      cwd: params.cwd,
      ...(permission ? { permissions: permission } : {}),
      ...(params.model ? { model: params.model } : {}),
      ...(params.effort ? { config: { model_reasoning_effort: params.effort } } : {}),
      dynamicTools: tools,
    })
    const thread = isObject(created) && isObject(created.thread) ? created.thread : null
    if (typeof thread?.id !== 'string')
      throw new Error('The harness did not return a manager thread.')
    manager.threadId = thread.id
    this.tree.host.index.see(
      { id: thread.id, updatedAt: thread.updatedAt, ephemeral: thread.ephemeral },
      params.harness,
    )
    this.tree.noteSubscribed(params.harness, thread.id)
    this.store.transaction(() => {
      this.store.saveManager(manager)
      this.store.saveReset({
        managerId: manager.id,
        oldThreadId: manager.threadId,
        phase: 'idle',
        applied: managerFingerprint(tools),
      })
      this.store.record(manager.id, 'manager', 'user', null, manager, 'Manager created')
      this.store.enqueue(
        manager.id,
        firstTask.trim()
          ? firstTask
          : formatSessionEvent({
              kind: 'manager-open',
              notes: [],
              manager: { managerId: manager.id, text: managerOpenText(manager.scope) },
            }),
      )
    })
    if (manager.name)
      await link
        .request('thread/name/set', { threadId: thread.id, name: manager.name })
        .catch((error) => this.tree.host.log(`经理起名失败：${String(error)}`))
    else if (link.native) this.born(manager.harness, thread)
    this.tree.host.threadStarted(params.harness, thread)
    this.changed(manager.id)
    this.kick(manager.id)
    return { manager: this.manager(manager.id), threadId: thread.id }
  }
  private rememberRules(manager: Manager): void {
    const tools = managerTools(manager, this.tree.host.taskCards(manager.harness))
    const record = this.tree.store.instructions(manager.threadId)
    if (record) {
      // 设置更新没有重新安装工具；只替换已登记的经理规则，保留后台接续等其他命名空间。
      const updated = ruledNamespaces(tools)
      this.tree.store.setInstructions(manager.threadId, {
        ...record,
        namespaces: record.namespaces.map(
          (namespace) => updated.find((one) => one.name === namespace.name) ?? namespace,
        ),
      })
    }
  }
  async tool(call: DeviceToolCall): Promise<ClientToolCallResponse> {
    try {
      const refusal = this.resets.refusal(call.threadId)
      if (refusal) throw new ManagerError('invalidManager', refusal)
      const questionManager = this.questions.managerFor(call.threadId)
      const manager = questionManager
        ? this.store.manager(questionManager)
        : this.store.forThread(call.threadId)
      if (!this.questions.allowed(call.threadId, call.namespace, call.tool))
        throw new ManagerError(
          'invalidManager',
          'This operation is not available in a temporary decision conversation.',
        )
      if (!manager || manager.harness !== call.harness)
        throw new ManagerError(
          'invalidManager',
          'litch_manager is available only in its owning manager session.',
        )
      let result: unknown
      if (call.tool.startsWith('issue_')) {
        const args = validateTool(call.tool, call.arguments)
        if (questionManager) {
          const state = this.store.questions(manager.id).find((q) => q.threadId === call.threadId)
          if (call.tool !== 'issue_get' || !state || text(args.id, 'id') !== state.decisionId)
            throw new ManagerError(
              'invalidManager',
              'Temporary conversations may only read their current issue.',
            )
        }
        const methods: Record<string, string> = {
          issue_get: MANAGER_ISSUE_METHOD.read,
          issue_create: MANAGER_ISSUE_METHOD.create,
          issue_update: MANAGER_ISSUE_METHOD.update,
          issue_comment: MANAGER_ISSUE_METHOD.comment,
          issue_follow: MANAGER_ISSUE_METHOD.follow,
        }
        result = this.issues.call(
          methods[call.tool]!,
          {
            ...args,
            managerId: manager.id,
            ...(['issue_create', 'issue_comment'].includes(call.tool) &&
            args.idempotencyKey === undefined
              ? { idempotencyKey: `${call.harness}:${call.threadId}:${call.callId}` }
              : {}),
          },
          'manager',
        )
      } else if (['report', 'post_get', 'post_reply', 'relate'].includes(call.tool)) {
        if (questionManager) this.questions.validateWrite(call.threadId, call.tool, call.arguments)
        result = this.posts.tool(
          manager.id,
          call.tool,
          call.arguments,
          questionManager ? 'question' : 'manager',
        )
        if (questionManager && call.tool === 'post_reply')
          this.questions.noteChange(call.threadId, result)
        if (call.tool !== 'post_get') this.changed(manager.id)
      } else if (call.tool === 'endorse' || call.tool === 'dismiss') {
        this.writer.active(manager.id)
        const args = validateTool(call.tool, call.arguments)
        const proposalId = text(args.proposalId, 'proposalId')
        const proposal = this.tree.pendingProposal(proposalId)
        const mark = this.lines.mark(proposal.threadId)
        if (proposal.offer || mark?.managerId !== manager.id || mark.role !== 'line')
          throw new ManagerError(
            'invalidManager',
            'Only pending suggestions from your own workline subtree can be reviewed.',
          )
        if (this.tree.accepting.has(proposalId))
          throw new ManagerError('invalidManager', 'This suggestion is already starting.')
        const reason =
          call.tool === 'dismiss'
            ? text(args.reason, 'reason')
            : typeof args.reason === 'string'
              ? args.reason
              : null
        const review = {
          state: call.tool === 'endorse' ? ('endorsed' as const) : ('dismissed' as const),
          reason,
          at: managerNow(),
        }
        this.store.transaction(() => {
          const before = this.store.suggestionReview(manager.id, proposalId)
          this.store.saveSuggestionReview(manager.id, proposalId, review)
          this.store.record(
            manager.id,
            'manager',
            'manager',
            before,
            { proposalId, ...review },
            `${call.tool === 'dismiss' ? '经理忽略' : '经理审核'}：${proposal.title}${reason ? ` · ${reason}` : ''}`,
          )
          if (call.tool === 'dismiss') this.tree.settleProposal(proposalId, 'dismissed', null)
        })
        this.tree.suggestions.changed()
        this.changed(manager.id)
        result = { proposalId, review }
      } else if (call.tool === 'summary') {
        validateTool(call.tool, call.arguments)
        await this.lines.refresh(manager.id)
        const board = this.board(manager.id)
        result = {
          ...(!questionManager
            ? {
                issues: this.issues.list(manager.id, {
                  managerId: manager.id,
                  kinds: ['ordinary'],
                  order: 'updated',
                  limit: 100,
                }),
              }
            : {}),
          posts: board.posts?.map(({ id, kind, title, revision, unread }) => ({
            id,
            kind,
            title,
            revision,
            unread,
          })),
          situation: board.situation,
          decisions: board.decisions
            .filter((decision) => decision.status === 'open')
            .map((decision) => {
              if (!questionManager) return decision
              const { discussion: _discussion, ...fields } = decision
              return fields
            }),
          ignoredDecisions: board.decisions
            .filter((decision) => decision.status === 'ignored')
            .map(({ id, title }) => ({ id, title })),
          requests: board.requests?.filter((request) => request.status === 'open'),
          items: board.items.filter((item) => !['done', 'deferred'].includes(item.status)),
          lines: board.lines.filter((line) => line.running),
        }
      } else {
        if (
          manager.status === 'ending' &&
          call.tool !== 'get' &&
          !(await this.endings.canWrite(manager, call.turnId))
        )
          throw new ManagerError(
            'managerEnded',
            'Only the manager-end finalization turn can write while this manager is ending.',
          )
        if (questionManager) this.questions.validateWrite(call.threadId, call.tool, call.arguments)
        result = this.writer.tool(
          manager.id,
          call.tool,
          call.arguments,
          call.turnId,
          questionManager ? 'question' : 'manager',
        )
        if (questionManager && ['update', 'close'].includes(call.tool))
          this.questions.noteChange(call.threadId, result)
        if (call.tool !== 'get') this.changed(manager.id)
      }
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] }
    } catch (error) {
      return clientToolFailure(
        error instanceof ManagerError ? 'invalid' : 'failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  suggestionProposed(proposal: SessionProposal): void {
    const mark = this.lines.mark(proposal.threadId)
    if (mark?.role !== 'line') return
    const manager = this.store.manager(mark.managerId)
    if (manager?.status !== 'active') return
    const snapshot = this.lines.snapshots.get(proposal.threadId)
    const sourceTitle =
      typeof snapshot?.name === 'string' && snapshot.name.trim()
        ? snapshot.name
        : (this.tree.store.parentOf(proposal.threadId)?.title ?? proposal.threadId)
    this.store.enqueue(
      manager.id,
      formatSessionEvent({
        kind: 'manager-suggestions',
        notes: [],
        manager: {
          managerId: manager.id,
          text: `${shortObjectId(`S-${proposal.id}`)} ${JSON.stringify(proposal.title)} (proposalId: ${proposal.id})\nBackground: ${proposalSummary(proposal.background, proposal.prompt)}\nSource: ${JSON.stringify(sourceTitle)} (${proposal.threadId})\n请对照已合入的提交和事项查重，然后用 endorse 推荐或 dismiss 撤掉并写理由。 Check landed commits and manager items for duplicates, then use litch_manager.endorse or dismiss with a reason; do not leave this unreviewed.`,
        },
      }),
    )
    if (this.suggestionTimers.has(manager.id)) return
    const timer = setTimeout(() => {
      this.suggestionTimers.delete(manager.id)
      this.kick(manager.id)
    }, 250)
    timer.unref()
    this.suggestionTimers.set(manager.id, timer)
  }
  kick(id: string): void {
    if (
      this.closed ||
      this.draining.has(id) ||
      this.resets.held(this.store.manager(id)?.threadId ?? '')
    )
      return
    const pending = this.drain(id)
      .catch((error) => this.tree.host.log(`经理事件留待重试：${String(error)}`))
      .finally(() => {
        this.draining.delete(id)
      })
    this.draining.set(id, pending)
  }
  private async drain(id: string): Promise<void> {
    const manager = this.store.manager(id)
    if (!manager) return
    if (manager.status === 'ended') return
    if (manager.status === 'ending') await this.endings.recover(id)
    const deliveries = this.store.deliveries(id)
    let suggestionsVisited = false
    for (const [index, event] of deliveries.entries()) {
      if (this.closed || this.resets.held(manager.threadId)) return
      const parsed = parseSessionEvent(event.text)
      if (parsed.event?.kind === 'manager-issue' && manager.status !== 'active') continue
      if (parsed.event?.kind === 'manager-suggestions') {
        if (suggestionsVisited || this.suggestionTimers.has(id)) continue
        suggestionsVisited = true
        // 独立于普通回报，避免同一来源的后续回报覆盖或截断卡片；重置后沿经理 ID 投递。
        const batch = deliveries.filter(
          (next) => parseSessionEvent(next.text).event?.kind === 'manager-suggestions',
        )
        let currentBatch: typeof batch = []
        const prepare = () => {
          currentBatch = batch.filter((entry) => {
            const body = parseSessionEvent(entry.text).event?.manager?.text ?? ''
            // 单卡持久事件的首行固定带完整 proposalId；只读此标记，不从标题或背景推断身份。
            const proposalId = /\(proposalId: ([0-9a-f-]+)\)$/.exec(body.split('\n')[0] ?? '')?.[1]
            const proposal = proposalId ? this.tree.proposal(proposalId) : null
            const pending =
              proposal &&
              proposal.status === 'pending' &&
              !proposal.offer &&
              !this.tree.accepting.has(proposal.id) &&
              !this.store.suggestionReview(id, proposal.id)
            if (!pending) this.store.delivered(entry.id)
            return Boolean(pending)
          })
          if (!currentBatch.length) return null
          return {
            text: formatSessionEvent({
              kind: 'manager-suggestions',
              notes: [],
              manager: {
                managerId: id,
                text: currentBatch
                  .map((entry) => parseSessionEvent(entry.text).event?.manager?.text ?? '')
                  .join('\n\n'),
              },
            }),
            // 过滤后仍保留稳定身份；重试时新增或已处理的卡改变批次，不能被旧 ID 去重。
            eventId: `litch-suggestions-${createHash('sha256')
              .update(currentBatch.map((entry) => entry.id).join('\n'))
              .digest('hex')}`,
          }
        }
        const sent =
          manager.status === 'active' &&
          (await this.tree.deliverManagerEvent(manager.threadId, '', '', {
            automatic: true,
            prepare,
          }))
        if (this.closed) return
        if (sent) for (const entry of currentBatch) this.store.delivered(entry.id)
        // 唤醒被保护规则阻止时仍允许后面的用户答复投递，不能堵住用户。
        continue
      }
      // 结束回合单独开，避免结束请求把当前回合冒充成收尾回合。
      if (parsed.event?.kind === 'manager-end' && this.tree.isActive(manager.threadId)) return
      let text = event.text
      if (parsed.event?.kind === 'manager-ignored' && parsed.event.manager) {
        // 忽略事件不开回合：经理闲着、后面也没有要开回合的事件就先留着
        const later = deliveries
          .slice(index + 1)
          .some(
            (next) =>
              !['manager-ignored', 'manager-suggestions'].includes(
                parseSessionEvent(next.text).event?.kind ?? '',
              ),
          )
        if (!later && !this.tree.isActive(manager.threadId)) continue
        // 交出前已撤销忽略或被重开的条目不再告诉经理
        const board = this.store.objects(id)
        const ignored = (parsed.event.manager.ignored ?? []).filter((entry) =>
          board.some((object) => object.id === entry.decisionId && object.status === 'ignored'),
        )
        if (!ignored.length) {
          this.store.delivered(event.id)
          continue
        }
        text = formatSessionEvent({
          ...parsed.event,
          manager: { ...parsed.event.manager, ignored },
        })
      }
      const sent = await this.tree.deliverManagerEvent(
        manager.threadId,
        text,
        event.id,
        parsed.event?.kind === 'manager-end'
          ? { startOnly: true, onStarted: (turnId) => this.endings.started(id, turnId) }
          : {},
      )
      if (this.closed || !sent) return
      this.store.delivered(event.id)
      if (parsed.event?.kind === 'manager-end') await this.endings.recover(id)
    }
  }
  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    for (const timer of this.suggestionTimers.values()) clearTimeout(timer)
    this.suggestionTimers.clear()
    this.unlisten()
    await this.resets.close()
    await this.questions.close()
    await Promise.allSettled(this.draining.values())
    this.store.close()
  }
  async settleDeliveries(id: string): Promise<void> {
    await this.draining.get(id)
  }
}
