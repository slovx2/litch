import {
  MANAGER_POST_METHOD,
  type ManagerPostQuestionParams,
  type ManagerReportReadParams,
} from '../../../protocol/src/manager-posts.mjs'
// 经理列表常驻，看板按需读取；开启桌面通知的经理也常驻读取看板以发现新决策。
// 设备通知使快照失效；在途读取期间再有通知则补读一次。

import {
  MANAGER_METHOD,
  MANAGER_NOTIFICATION,
  type Manager,
  type ManagerChangedNotification,
  type ManagerDecision,
  type ManagerDecisionIgnoreParams,
  type ManagerDecisionReopenParams,
  type ManagerFeedbackSubmitParams,
  type ManagerQuestionParams,
  type ManagerSubmittedAnswer,
} from '../../../protocol/src/manager.mjs'
import {
  MANAGER_ISSUE_NOTIFICATION,
  type ManagerIssueRequests,
} from '../../../protocol/src/manager-issues.mjs'
import {
  MANAGER_PAGING_METHOD,
  type ManagerPageQuery,
} from '../../../protocol/src/manager-paging.mjs'
import { managerInputIssue } from '../../../protocol/src/manager-validation.mjs'
import { ChannelError } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import type { ManagerRequests } from '../connection/manager-protocol.mjs'
import { RpcError } from '../connection/rpc.mjs'
import type {
  ManagerBoardTopicView,
  ManagerBoardView,
  ManagerDraft,
  ManagerEdit,
  ManagerFeaturesView,
  ManagersView,
  ManagerView,
} from '../model-manager.mjs'
import {
  projectManager,
  projectManagerAnswers,
  projectManagerBoard,
  projectManagerDecision,
  projectManagerPost,
  projectManagerRequest,
} from '../projection/manager.mjs'
import { projectManagerIssue } from '../projection/manager-public-issues.mjs'
import { openedManagerDecisions } from './manager-decisions.mjs'
import { ManagerIssueCache } from './manager-issues.mjs'
import { PagedManagerBoard } from './manager-paging.mjs'
import { managerValidationError } from './manager-validation.mjs'

export interface ManagersHost {
  deviceId: string
  online(): boolean
  supported(): boolean
  /** 设备宣告了哪些后加的经理能力 */
  features(): ManagerFeaturesView
  request<M extends keyof ManagerRequests>(
    method: M,
    params: ManagerRequests[M]['params'],
  ): Promise<ManagerRequests[M]['result']>
  fail(error: unknown): ChannelError
  changed(manager: Manager): void
  log(line: string): void
}
interface BoardEntry {
  issues?: ManagerIssueCache
  paged?: PagedManagerBoard
  observedHeads?: Map<string, number>
  sinks: Set<HostSink>
  view: ManagerBoardTopicView
  loading: boolean
  dirty: boolean
  observed: ManagerBoardView | null
  confirmed: Map<string, number>
}
export type Managers = ReturnType<typeof createManagers>

export function createManagers(host: ManagersHost) {
  const { deviceId } = host
  const sinks = new Set<HostSink>()
  const managers = new Map<string, ManagerView>()
  const boards = new Map<string, BoardEntry>()
  const issueEvents = new Set<string>()
  let available: boolean | null = null
  let epoch = 0
  let early: Manager[] | null = null
  const view = (): ManagersView => ({ deviceId, available, managers: [...managers.values()] })
  const snapshot = () => {
    for (const sink of sinks) sink.snapshot(view())
  }
  const keep = (raw: Manager, publish = true) => {
    const next = projectManager(deviceId, raw)
    const before = managers.get(next.id)
    if (before && before.updatedAt > next.updatedAt) return before
    managers.set(next.id, next)
    host.changed(raw)
    if (publish) for (const sink of sinks) sink.delta([{ op: 'manager.upsert', manager: next }])
    if (publish) watchBoards()
    return next
  }
  const publishBoard = (entry: BoardEntry) => {
    for (const sink of entry.sinks) sink.delta([{ op: 'managerBoard.set', view: entry.view }])
  }
  const loadBoard = async (managerId: string, entry: BoardEntry) => {
    if (!host.online() || !host.supported() || (!entry.sinks.size && !watching(managerId))) return
    if (entry.loading) {
      entry.dirty = true
      return
    }
    entry.loading = true
    entry.dirty = false
    const mine = epoch
    try {
      if (host.features().paging) {
        const first = !entry.paged
        const paged = paging(managerId, entry)
        await paged.refresh()
        if (mine !== epoch || boards.get(managerId) !== entry) return
        entry.confirmed.clear()
        if (first) void paged.lines().catch((error) => host.log(String(error)))
        if (watching(managerId)) await observePages(managerId, entry, mine)
        return
      }
      const { board } = await host.request(MANAGER_METHOD.boardRead, { managerId })
      if (mine !== epoch || boards.get(managerId) !== entry) return
      // 通知触发的在途读取可承接提交后的对账；版本不足才补读，不能闪回旧的待定状态。
      const revisions = new Map(board.decisions.map((decision) => [decision.id, decision.revision]))
      for (const [id, revision] of entry.confirmed)
        if ((revisions.get(id as ManagerDecision['id']) ?? 0) < revision) entry.dirty = true
      // 在途期间有失效通知：不先闪出一份已知过时的快照。
      if (!entry.dirty) {
        entry.confirmed.clear()
        const projected = projectManagerBoard(deviceId, board)
        const manager = managers.get(managerId)
        if (watching(managerId) && manager) {
          if (early === null)
            for (const decision of openedManagerDecisions(entry.observed, projected))
              for (const sink of sinks)
                sink.delta([{ op: 'manager.decisionOpened', manager, decision }])
          entry.observed = projected
        }
        entry.view = {
          deviceId,
          managerId,
          available: true,
          board: projected,
          ...(entry.view.issues ? { issues: entry.view.issues } : {}),
          features: host.features(),
        }
        publishBoard(entry)
      }
    } catch (error) {
      if (mine !== epoch || boards.get(managerId) !== entry) return
      entry.observed = null
      entry.view = { ...entry.view, loadError: String(error) }
      publishBoard(entry)
      host.log(`读取经理看板失败：${String(error)}`)
    } finally {
      if (mine === epoch && boards.get(managerId) === entry) {
        entry.loading = false
        if (entry.dirty) void loadBoard(managerId, entry)
      }
    }
  }
  const watching = (managerId: string): boolean =>
    sinks.size > 0 && managers.get(managerId)?.contact.desktopNotification === true
  const paging = (managerId: string, entry: BoardEntry) => {
    entry.paged ??= new PagedManagerBoard(host, managerId, (value) => {
      if (boards.get(managerId) !== entry) return
      entry.view = { ...entry.view, ...value, available: true, features: host.features() }
      delete entry.view.loadError
      const manager = managers.get(managerId)
      const summary = value.paging?.summary
      if (manager && summary) {
        const updated = {
          ...manager,
          pendingDecisions: summary.counts.decision.open ?? 0,
          pendingRequests: summary.counts.request.open ?? 0,
          pendingReports: summary.counts.report.unread ?? 0,
          pendingSuggestions: summary.counts.suggestion.pending ?? 0,
          runningLines: summary.lines.lines.filter((line) => line.running).length,
        }
        managers.set(managerId, updated)
        for (const sink of sinks) sink.delta([{ op: 'manager.upsert', manager: updated }])
      }
      publishBoard(entry)
    })
    return entry.paged
  }
  const observePages = async (managerId: string, entry: BoardEntry, mine: number) => {
    // 通知独立遍历开放议题的头字段，不能把首屏三十条误当成全部开放议题。
    const current = new Map<string, number>()
    let cursor: string | undefined
    do {
      const page = await host.request(MANAGER_PAGING_METHOD.page, {
        managerId,
        kind: 'decision',
        status: 'open',
        order: 'newest',
        limit: 100,
        ...(cursor ? { cursor } : {}),
      })
      for (const head of page.entries) current.set(head.id, head.revision)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    if (mine !== epoch || boards.get(managerId) !== entry) return
    const before = entry.observedHeads
    entry.observedHeads = current
    if (!before || early !== null) return
    for (const [id, revision] of current) {
      if (before.get(id) === revision) continue
      let opened = !before.has(id)
      if (!opened) {
        let next: string | undefined
        do {
          const history = await host.request(MANAGER_PAGING_METHOD.history, {
            managerId,
            id: id as ManagerDecision['id'],
            ...(next ? { cursor: next } : {}),
          })
          opened = history.changes.some(
            (change) =>
              change.before?.status !== 'open' &&
              change.after?.status === 'open' &&
              Number(change.after.revision) > (before.get(id) ?? 0),
          )
          next =
            !opened &&
            history.changes.every(
              (change) =>
                typeof change.after?.revision !== 'number' ||
                change.after.revision > (before.get(id) ?? 0),
            )
              ? (history.nextCursor ?? undefined)
              : undefined
        } while (next)
      }
      if (!opened) continue
      const detail = await host.request(MANAGER_PAGING_METHOD.detail, {
        managerId,
        id: id as ManagerDecision['id'],
      })
      const manager = managers.get(managerId)
      if (mine !== epoch || !manager || !detail.object || detail.object.status !== 'open') continue
      for (const sink of sinks)
        sink.delta([
          {
            op: 'manager.decisionOpened',
            manager,
            decision: projectManagerDecision(detail.object as ManagerDecision),
          },
        ])
    }
  }
  const boardEntry = (managerId: string): BoardEntry => {
    let entry = boards.get(managerId)
    if (!entry) {
      entry = {
        sinks: new Set(),
        view: { deviceId, managerId, available, board: null, features: host.features() },
        loading: false,
        dirty: false,
        observed: null,
        confirmed: new Map(),
      }
      boards.set(managerId, entry)
    }
    return entry
  }
  const watchBoards = () => {
    for (const id of managers.keys()) {
      if (!watching(id)) continue
      const entry = boardEntry(id)
      if (!entry.observed && !entry.observedHeads && !entry.loading) void loadBoard(id, entry)
    }
    for (const [id, entry] of boards) {
      if (watching(id)) continue
      entry.observed = null
      delete entry.observedHeads
      if (!entry.sinks.size) boards.delete(id)
    }
  }
  const invalidate = (managerId: string) => {
    const entry = boards.get(managerId)
    if (entry?.issues && host.features().issues)
      void entry.issues.refresh().catch((error) => host.log(String(error)))
    if (entry) void loadBoard(managerId, entry)
  }
  const applyDecisions = (managerId: string, decisions: ManagerDecision[]) => {
    const entry = boards.get(managerId)
    if (entry?.paged) {
      entry.paged.accepted(decisions)
      return
    }
    const board = entry?.view.board
    if (!entry || !board || !decisions.length) return
    const updates = new Map(decisions.map((decision) => [decision.id, decision]))
    // 提交回包就是设备已保存的状态，先同步给两端，再重读整板补齐历史和动态。
    // 版本更高的通知可能先到，迟到的提交结果不能把它覆盖回去。
    const next = board.decisions.map((previous) => {
      const decision = updates.get(previous.id)
      return decision && decision.revision > previous.revision
        ? projectManagerDecision(decision)
        : previous
    })
    if (next.every((decision, index) => decision === board.decisions[index])) return
    const posts = board.posts?.map((post) => {
      const decision = next.find((decision) => decision.id === post.id)
      return post.kind === 'decision' && decision && decision.revision > post.revision
        ? { ...post, revision: decision.revision, updatedAt: decision.updatedAt }
        : post
    })
    entry.view = {
      ...entry.view,
      board: { ...board, decisions: next, ...(posts ? { posts } : {}) },
    }
    publishBoard(entry)
    const manager = managers.get(managerId)
    const pendingDecisions = next.filter((decision) => decision.status === 'open').length
    if (manager && manager.pendingDecisions !== pendingDecisions) {
      const updated = { ...manager, pendingDecisions }
      managers.set(managerId, updated)
      for (const sink of sinks) sink.delta([{ op: 'manager.upsert', manager: updated }])
    }
  }
  const refreshAnswers = (managerId: string, decisions: ManagerDecision[], complete: boolean) => {
    const entry = boards.get(managerId)
    const known = new Map(
      entry?.view.board?.decisions.map((decision) => [decision.id, decision.revision]),
    )
    // 回包前已收到相同或更高版本的整板时，无需再次对账。
    const pending = decisions.filter(
      (decision) => decision.revision > (known.get(decision.id) ?? 0),
    )
    applyDecisions(managerId, decisions)
    if (!entry || !complete || !decisions.length) return invalidate(managerId)
    for (const decision of pending) entry.confirmed.set(decision.id, decision.revision)
    if (entry.confirmed.size && !entry.loading) void loadBoard(managerId, entry)
  }
  const reconcile = async () => {
    const mine = epoch
    early = []
    try {
      const result = await host.request(
        host.features().paging ? MANAGER_PAGING_METHOD.catalog : MANAGER_METHOD.list,
        {},
      )
      if (mine !== epoch) return
      managers.clear()
      for (const manager of result.managers) keep(manager, false)
      for (const manager of early ?? []) keep(manager, false)
      early = null
      available = true
      snapshot()
      watchBoards()
    } catch (error) {
      if (mine !== epoch) return
      const pending = early ?? []
      early = null
      for (const manager of pending) keep(manager)
      watchBoards()
      host.log(`读取经理列表失败：${String(error)}`)
    }
  }
  const failure = (error: unknown): ChannelError => {
    if (error instanceof RpcError) {
      const data = error.data as {
        litch?: string
        field?: string
        reason?: string
        value?: string
        resolvedPath?: string
      } | null
      const faults: Record<string, [ChannelError['code'], string]> = {
        unknownManager: ['notFound', '经理不存在'],
        managerEnded: ['rejected', '经理已结束，看板只读'],
        unknownDecision: ['notFound', '决策不存在'],
        unknownIssue: ['notFound', '议题不存在或不属于此经理'],
        unknownComment: ['notFound', '评论不存在或不属于此议题'],
        issueConflict: ['rejected', '议题已更新，请重新读取后再提交'],
        issueCommentConflict: ['rejected', '评论已更新，请重新读取后再编辑'],
        issueIdempotencyConflict: ['rejected', '此提交标识已用于不同内容'],
        issueForbidden: ['rejected', '只能编辑自己发表的评论'],
        issueTypeMismatch: ['rejected', '请使用此类型议题的快速操作'],
        decisionNotClosed: ['rejected', '只能重新打开已关闭的决策'],
        lineLimitReached: ['rejected', '运行中的工作线已达上限'],
      }
      // 不认识的方法：新设备回标准 -32601；0.27 及更早的设备回 invalidManager、原文以 Unknown manager method 开头。
      // 只把明确的不认识方法解释为版本问题，字段错误保留具体原因。
      if (
        error.code === -32601 ||
        (data?.litch === 'invalidManager' && error.message.startsWith('Unknown manager method'))
      )
        return oldDevice(error.message)
      if (data?.litch === 'invalidManager')
        return managerValidationError(error.message, data.field, data.reason, data)
      const fault = data?.litch ? faults[data.litch] : undefined
      if (fault)
        return new ChannelError(fault[0], error.message, undefined, {
          said: { 'zh-CN': fault[1], en: error.message },
          ...(data?.field ? { key: data.field } : {}),
        })
    }
    return host.fail(error)
  }
  /** 设备服务比应用旧、不认这个操作：说清原因和去哪里升级，不说成“设置无效” */
  const oldDevice = (message: string) =>
    new ChannelError('unsupported', message, undefined, {
      said: {
        'zh-CN': '设备服务版本较旧，不支持这个操作。请在设备详情里升级设备服务后再试。',
        en: 'The device service is older than this app and does not support this action. Upgrade the device service in the device details, then try again.',
      },
    })
  /** 设备没宣告这项能力时不发请求（界面已禁用入口，这里兜底） */
  const requires = (feature: keyof ManagerFeaturesView, method: string) => {
    if (host.online() && host.supported() && !host.features()[feature])
      throw oldDevice(`${method} is not supported by this device service.`)
  }
  const guarded = async <T,>(run: () => Promise<T>): Promise<T> => {
    if (!host.online())
      throw new ChannelError('offline', '设备未连接', undefined, {
        said: { 'zh-CN': '设备未连接', en: 'Device is offline' },
      })
    if (!host.supported())
      throw new ChannelError('unsupported', '此设备不支持经理', undefined, {
        said: { 'zh-CN': '此设备不支持经理', en: 'This device does not support managers' },
      })
    const mine = epoch
    try {
      const result = await run()
      if (mine !== epoch)
        throw new ChannelError('offline', '设备连接已断开', undefined, {
          said: { 'zh-CN': '设备连接已断开', en: 'Device disconnected' },
        })
      return result
    } catch (error) {
      throw failure(error)
    }
  }
  const settle = (manager: Manager) => {
    // 对账请求尚未完成时，也保留自己命令写入的结果。
    early?.push(manager)
    const next = keep(manager)
    invalidate(manager.id)
    return next
  }
  return {
    async issue<M extends keyof ManagerIssueRequests>(
      method: M,
      params: ManagerIssueRequests[M]['params'],
    ) {
      requires('issues', method)
      const entry = boardEntry(params.managerId)
      entry.issues ??= new ManagerIssueCache(host, params.managerId, (issues) => {
        entry.view = { ...entry.view, issues }
        publishBoard(entry)
      })
      return guarded(() => entry.issues!.call(method, params))
    },
    async resolveReferences(managerId: string, ids: string[]) {
      if (
        !Array.isArray(ids) ||
        ids.length > 100 ||
        ids.some((id) => typeof id !== 'string' || !/^(?:[DIRPX]-\d+|S-[\w]+(?:-[\w]+)*)$/.test(id))
      )
        throw new ChannelError('invalid', 'Invalid manager references')
      if (host.features().issues) {
        const found = await Promise.all(
          ids.map(async (id) => {
            try {
              if (id.startsWith('I-')) {
                const result = await host.request(MANAGER_PAGING_METHOD.detail, {
                  managerId,
                  id: id as `I-${number}`,
                })
                return result.object ? id : null
              }
              await host.request('litch/manager/issue/read', {
                managerId,
                id: id as import('../../../protocol/src/manager-issues.mjs').ManagerIssueRef,
              })
              return id
            } catch {
              return null
            }
          }),
        )
        return { ids: found.filter((id): id is string => id !== null) }
      }
      if (!host.features().paging) {
        const { board } = await host.request(MANAGER_METHOD.boardRead, { managerId })
        const known = new Set(
          [
            ...board.decisions,
            ...board.items,
            ...(board.requests ?? []),
            ...(board.posts ?? []),
          ].map((object) => object.id),
        )
        return {
          ids: ids.filter((id) => known.has(id as import('../model-manager.mjs').ManagerObjectId)),
        }
      }
      // 仅校验正文中实际出现的编号，不污染看板分页状态或把缺失编号显示成加载错误。
      const found = await Promise.all(
        ids.map(async (id) => {
          try {
            const result = await host.request(MANAGER_PAGING_METHOD.detail, {
              managerId,
              id: id as import('../model-manager.mjs').ManagerObjectId,
            })
            return result.object || result.post ? id : null
          } catch {
            return null
          }
        }),
      )
      return { ids: found.filter((id): id is string => id !== null) }
    },
    beforeInput(sessionId: string): Promise<void> | undefined {
      const manager = [...managers.values()].find(
        (entry) =>
          entry.threadId === sessionId &&
          entry.status === 'active' &&
          entry.reset?.phase === 'waiting',
      )
      if (!manager) return
      // 本机排队也算用户发送，不能等真正发 turn/start 时才取消等待。
      return guarded(() =>
        host.request(MANAGER_METHOD.resetCancel, { managerId: manager.id }),
      ).then((result) => {
        settle(result.manager)
      })
    },
    async page(managerId: string, query: ManagerPageQuery, more?: boolean) {
      requires('paging', MANAGER_PAGING_METHOD.page)
      await guarded(() => paging(managerId, boardEntry(managerId)).page(query, more))
      return {}
    },
    async detail(managerId: string, id: import('../model-manager.mjs').ManagerObjectId) {
      requires('paging', MANAGER_PAGING_METHOD.detail)
      await guarded(() => paging(managerId, boardEntry(managerId)).detail(id))
      return {}
    },
    async history(
      managerId: string,
      id: import('../model-manager.mjs').ManagerObjectId,
      more?: boolean,
    ) {
      requires('paging', MANAGER_PAGING_METHOD.history)
      await guarded(() => paging(managerId, boardEntry(managerId)).history(id, more))
      return {}
    },
    async refresh(managerId: string, lines?: boolean) {
      await guarded(() =>
        lines && host.features().paging
          ? paging(managerId, boardEntry(managerId)).lines()
          : loadBoard(managerId, boardEntry(managerId)),
      )
      return {}
    },
    open(sink: HostSink) {
      sinks.add(sink)
      sink.snapshot(view())
      watchBoards()
      return () => {
        sinks.delete(sink)
        watchBoards()
      }
    },
    openBoard(managerId: string, sink: HostSink) {
      const entry = boardEntry(managerId)
      const first = entry.sinks.size === 0
      entry.sinks.add(sink)
      sink.snapshot(entry.view)
      // 通知观察器正在读取或已有持续订阅的快照时可以复用；新增读者不代表快照失效。
      if (first && !entry.loading && !entry.observed && !entry.observedHeads)
        void loadBoard(managerId, entry)
      const watched = entry
      return () => {
        watched.sinks.delete(sink)
        if (!watched.sinks.size && !watching(managerId)) boards.delete(managerId)
      }
    },
    resync() {
      epoch++
      early = null
      for (const entry of boards.values()) {
        entry.issues?.stop()
        if (host.features().issues)
          void entry.issues?.refresh().catch((error) => host.log(String(error)))
        entry.paged?.stop()
        delete entry.paged
        delete entry.observedHeads
        entry.loading = false
        entry.dirty = false
        entry.observed = null
        entry.confirmed.clear()
      }
      if (!host.supported()) {
        available = false
        managers.clear()
        snapshot()
        for (const entry of boards.values()) {
          entry.view = { ...entry.view, available: false, board: null, features: host.features() }
          publishBoard(entry)
        }
        return
      }
      // 新订阅不能把正在读取的空目录当成完整目录，否则经理会被暂时路由到普通对话。
      available = null
      void reconcile()
      for (const [id, entry] of boards) void loadBoard(id, entry)
    },
    offline() {
      epoch++
      early = null
      for (const entry of boards.values()) {
        entry.issues?.stop()
        entry.paged?.stop()
        delete entry.paged
        delete entry.observedHeads
        entry.loading = false
        entry.dirty = false
        entry.observed = null
        entry.confirmed.clear()
      }
    },
    notification(method: string, params: unknown): boolean {
      if ((Object.values(MANAGER_ISSUE_NOTIFICATION) as string[]).includes(method)) {
        if (host.online() && host.features().issues) {
          const event =
            params as import('../../../protocol/src/manager-issues.mjs').ManagerIssueActivityNotification
          invalidate(event.managerId)
          const manager = managers.get(event.managerId)
          if (
            method === MANAGER_ISSUE_NOTIFICATION.activity &&
            event.actor === 'manager' &&
            manager?.contact.desktopNotification &&
            !issueEvents.has(event.eventId)
          ) {
            issueEvents.add(event.eventId)
            if (issueEvents.size > 1000) issueEvents.delete(issueEvents.values().next().value!)
            const mine = epoch
            void host
              .request('litch/manager/issue/read', {
                managerId: event.managerId,
                id: event.issueId,
              })
              .then(({ issue }) => {
                if (mine !== epoch) return
                for (const sink of sinks)
                  sink.delta([
                    {
                      op: 'manager.issueActivity',
                      manager,
                      event,
                      issue: projectManagerIssue(issue),
                    },
                  ])
              })
              .catch((error) => host.log(String(error)))
          }
        }
        return true
      }
      if (method !== MANAGER_NOTIFICATION.changed && method !== MANAGER_NOTIFICATION.boardChanged)
        return false
      if (!host.online() || !host.supported()) return true
      if (method === MANAGER_NOTIFICATION.changed) {
        const { manager } = params as ManagerChangedNotification
        if (early) early.push(manager)
        else keep(manager)
      } else invalidate((params as { managerId: string }).managerId)
      return true
    },
    async create(draft: ManagerDraft) {
      const issue = managerInputIssue(draft, 'create')
      if (issue) throw managerValidationError(issue.message, issue.field, issue.reason, issue)
      const result = await guarded(() => host.request(MANAGER_METHOD.create, draft))
      return { manager: settle(result.manager), threadId: result.threadId }
    },
    async update(managerId: string, patch: ManagerEdit) {
      const issue = managerInputIssue(patch, 'patch')
      if (issue) throw managerValidationError(issue.message, issue.field, issue.reason, issue)
      const result = await guarded(() =>
        host.request(MANAGER_METHOD.update, { managerId, ...patch }),
      )
      return { manager: settle(result.manager) }
    },
    async cancelReset(managerId: string) {
      const result = await guarded(() => host.request(MANAGER_METHOD.resetCancel, { managerId }))
      return { manager: settle(result.manager) }
    },
    async reset(managerId: string, boardOnly?: boolean) {
      const result = await guarded(() =>
        host.request(MANAGER_METHOD.reset, {
          managerId,
          ...(boardOnly === undefined ? {} : { boardOnly }),
        }),
      )
      return { manager: settle(result.manager) }
    },
    async end(managerId: string) {
      const result = await guarded(() => host.request(MANAGER_METHOD.end, { managerId }))
      return { manager: settle(result.manager) }
    },
    async feedback(params: ManagerFeedbackSubmitParams) {
      if (params.requests?.some((request) => request.ignored))
        requires('requestIgnore', MANAGER_METHOD.feedbackSubmit)
      // 旧设备没有 feedback/submit：只有决策答复时改走 answers/submit（经理第一版就有），有追问或交付的不发
      if (host.online() && host.supported() && !host.features().feedback) {
        if (params.questions.length || params.requests?.length)
          throw oldDevice(
            `${MANAGER_METHOD.feedbackSubmit} is not supported by this device service.`,
          )
        const answered = await guarded(() =>
          host.request(MANAGER_METHOD.answersSubmit, {
            managerId: params.managerId,
            answers: params.answers,
          }),
        )
        refreshAnswers(params.managerId, answered.accepted, !answered.rejected.length)
        return {
          ...projectManagerAnswers(answered),
          acceptedRequests: [],
          rejectedRequests: [],
          acceptedQuestions: [],
          rejectedQuestions: [],
        }
      }
      const result = await guarded(() => host.request(MANAGER_METHOD.feedbackSubmit, params))
      refreshAnswers(
        params.managerId,
        result.accepted,
        !result.rejected.length && !params.questions.length && !params.requests?.length,
      )
      return {
        ...projectManagerAnswers(result),
        acceptedRequests: result.acceptedRequests.map(projectManagerRequest),
        rejectedRequests: result.rejectedRequests.map((entry) => ({
          ...entry,
          request: entry.request ? projectManagerRequest(entry.request) : null,
        })),
        acceptedQuestions: result.acceptedQuestions.map(projectManagerDecision),
        rejectedQuestions: projectManagerAnswers({ ...result, rejected: result.rejectedQuestions })
          .rejected,
      }
    },
    async submit(managerId: string, answers: ManagerSubmittedAnswer[]) {
      const result = await guarded(() =>
        host.request(MANAGER_METHOD.answersSubmit, { managerId, answers }),
      )
      refreshAnswers(managerId, result.accepted, !result.rejected.length)
      return projectManagerAnswers(result)
    },
    async ignore(params: ManagerDecisionIgnoreParams) {
      requires('ignore', MANAGER_METHOD.decisionIgnore)
      const result = await guarded(() => host.request(MANAGER_METHOD.decisionIgnore, params))
      invalidate(params.managerId)
      return { decision: projectManagerDecision(result.decision) }
    },
    async reopen(params: ManagerDecisionReopenParams) {
      const result = await guarded(() => host.request(MANAGER_METHOD.decisionReopen, params))
      invalidate(params.managerId)
      return { decision: projectManagerDecision(result.decision) }
    },
    async reference(params: { managerId: string; reference: string }) {
      requires('posts', MANAGER_POST_METHOD.reference)
      return guarded(() => host.request(MANAGER_POST_METHOD.reference, params))
    },
    async postForward(params: {
      managerId: string
      id: import('../../../protocol/src/manager-posts.mjs').ManagerPostId
    }) {
      requires('posts', MANAGER_POST_METHOD.forward)
      const result = await guarded(() => host.request(MANAGER_POST_METHOD.forward, params))
      invalidate(params.managerId)
      return result
    },
    async postQuestion(params: ManagerPostQuestionParams) {
      requires('posts', MANAGER_POST_METHOD.question)
      const result = await guarded(() => host.request(MANAGER_POST_METHOD.question, params))
      invalidate(params.managerId)
      return { post: projectManagerPost(result.post) }
    },
    async reportRead(params: ManagerReportReadParams) {
      requires('posts', MANAGER_POST_METHOD.read)
      const result = await guarded(() => host.request(MANAGER_POST_METHOD.read, params))
      invalidate(params.managerId)
      return { post: projectManagerPost(result.post) }
    },
    async ask(params: ManagerQuestionParams) {
      requires('posts', MANAGER_METHOD.questionAsk)
      await guarded(() => host.request(MANAGER_METHOD.questionAsk, params))
      invalidate(params.managerId)
      return {}
    },
    async forward(params: ManagerDecisionReopenParams) {
      requires('posts', MANAGER_METHOD.questionForward)
      const result = await guarded(() => host.request(MANAGER_METHOD.questionForward, params))
      invalidate(params.managerId)
      return result
    },
  }
}
