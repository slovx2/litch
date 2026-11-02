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
  type ManagerDecisionIgnoreParams,
  type ManagerDecisionReopenParams,
  type ManagerFeedbackSubmitParams,
  type ManagerQuestionParams,
  type ManagerSubmittedAnswer,
} from '../../../protocol/src/manager.mjs'
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
import { openedManagerDecisions } from './manager-decisions.mjs'

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
  sinks: Set<HostSink>
  view: ManagerBoardTopicView
  loading: boolean
  dirty: boolean
  observed: ManagerBoardView | null
}
export type Managers = ReturnType<typeof createManagers>

export function createManagers(host: ManagersHost) {
  const { deviceId } = host
  const sinks = new Set<HostSink>()
  const managers = new Map<string, ManagerView>()
  const boards = new Map<string, BoardEntry>()
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
      const { board } = await host.request(MANAGER_METHOD.boardRead, { managerId })
      if (mine !== epoch || boards.get(managerId) !== entry) return
      // 在途期间有失效通知：不先闪出一份已知过时的快照。
      if (!entry.dirty) {
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
          features: host.features(),
        }
        publishBoard(entry)
      }
    } catch (error) {
      if (mine !== epoch || boards.get(managerId) !== entry) return
      entry.observed = null
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
  const boardEntry = (managerId: string): BoardEntry => {
    let entry = boards.get(managerId)
    if (!entry) {
      entry = {
        sinks: new Set(),
        view: { deviceId, managerId, available, board: null, features: host.features() },
        loading: false,
        dirty: false,
        observed: null,
      }
      boards.set(managerId, entry)
    }
    return entry
  }
  const watchBoards = () => {
    for (const id of managers.keys()) {
      if (!watching(id)) continue
      const entry = boardEntry(id)
      if (!entry.observed && !entry.loading) void loadBoard(id, entry)
    }
    for (const [id, entry] of boards) {
      if (watching(id)) continue
      entry.observed = null
      if (!entry.sinks.size) boards.delete(id)
    }
  }
  const invalidate = (managerId: string) => {
    const entry = boards.get(managerId)
    if (entry) void loadBoard(managerId, entry)
  }
  const reconcile = async () => {
    const mine = epoch
    early = []
    try {
      const result = await host.request(MANAGER_METHOD.list, {})
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
      const data = error.data as { litch?: string; field?: string } | null
      const faults: Record<string, [ChannelError['code'], string]> = {
        unknownManager: ['notFound', '经理不存在'],
        managerEnded: ['rejected', '经理已结束，看板只读'],
        invalidManager: ['invalid', '经理设置无效，请检查填写的内容'],
        unknownDecision: ['notFound', '决策不存在'],
        decisionNotClosed: ['rejected', '只能重新打开已关闭的决策'],
        lineLimitReached: ['rejected', '运行中的工作线已达上限'],
      }
      // 不认识的方法：新设备回标准 -32601；0.27 及更早的设备回 invalidManager、原文以 Unknown manager method 开头。
      // 只认这一种 invalidManager，别的照旧是“设置无效”
      if (
        error.code === -32601 ||
        (data?.litch === 'invalidManager' && error.message.startsWith('Unknown manager method'))
      )
        return oldDevice(error.message)
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
      if (first) void loadBoard(managerId, entry)
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
        entry.loading = false
        entry.dirty = false
        entry.observed = null
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
      available = true
      void reconcile()
      for (const [id, entry] of boards) void loadBoard(id, entry)
    },
    offline() {
      epoch++
      early = null
      for (const entry of boards.values()) {
        entry.loading = false
        entry.dirty = false
        entry.observed = null
      }
    },
    notification(method: string, params: unknown): boolean {
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
      const result = await guarded(() => host.request(MANAGER_METHOD.create, draft))
      return { manager: settle(result.manager), threadId: result.threadId }
    },
    async update(managerId: string, patch: ManagerEdit) {
      const result = await guarded(() =>
        host.request(MANAGER_METHOD.update, { managerId, ...patch }),
      )
      return { manager: settle(result.manager) }
    },
    async end(managerId: string) {
      const result = await guarded(() => host.request(MANAGER_METHOD.end, { managerId }))
      return { manager: settle(result.manager) }
    },
    async feedback(params: ManagerFeedbackSubmitParams) {
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
        invalidate(params.managerId)
        return {
          ...projectManagerAnswers(answered),
          acceptedRequests: [],
          rejectedRequests: [],
          acceptedQuestions: [],
          rejectedQuestions: [],
        }
      }
      const result = await guarded(() => host.request(MANAGER_METHOD.feedbackSubmit, params))
      invalidate(params.managerId)
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
      invalidate(managerId)
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
