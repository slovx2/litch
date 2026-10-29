// 经理列表常驻，看板按需读取。通知使快照失效；在途读取期间再有通知则补读一次。

import {
  MANAGER_METHOD,
  MANAGER_NOTIFICATION,
  type Manager,
  type ManagerChangedNotification,
  type ManagerDecisionReopenParams,
  type ManagerSubmittedAnswer,
} from '../../../protocol/src/manager.mjs'
import { ChannelError } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import type { ManagerRequests } from '../connection/manager-protocol.mjs'
import { RpcError } from '../connection/rpc.mjs'
import type {
  ManagerBoardTopicView,
  ManagerDraft,
  ManagerEdit,
  ManagersView,
  ManagerView,
} from '../model-manager.mjs'
import {
  projectManager,
  projectManagerAnswers,
  projectManagerBoard,
  projectManagerDecision,
} from '../projection/manager.mjs'

export interface ManagersHost {
  deviceId: string
  online(): boolean
  supported(): boolean
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
    return next
  }
  const publishBoard = (entry: BoardEntry) => {
    for (const sink of entry.sinks) sink.delta([{ op: 'managerBoard.set', view: entry.view }])
  }
  const loadBoard = async (managerId: string, entry: BoardEntry) => {
    if (!host.online() || !host.supported() || !entry.sinks.size) return
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
        entry.view = {
          deviceId,
          managerId,
          available: true,
          board: projectManagerBoard(deviceId, board),
        }
        publishBoard(entry)
      }
    } catch (error) {
      if (mine !== epoch || boards.get(managerId) !== entry) return
      host.log(`读取经理看板失败：${String(error)}`)
    } finally {
      if (mine === epoch && boards.get(managerId) === entry) {
        entry.loading = false
        if (entry.dirty) void loadBoard(managerId, entry)
      }
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
    } catch (error) {
      if (mine !== epoch) return
      const pending = early ?? []
      early = null
      for (const manager of pending) keep(manager)
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
      const fault = data?.litch ? faults[data.litch] : undefined
      if (fault)
        return new ChannelError(fault[0], error.message, undefined, {
          said: { 'zh-CN': fault[1], en: error.message },
          ...(data?.field ? { key: data.field } : {}),
        })
    }
    return host.fail(error)
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
      return () => {
        sinks.delete(sink)
      }
    },
    openBoard(managerId: string, sink: HostSink) {
      let entry = boards.get(managerId)
      if (!entry) {
        entry = {
          sinks: new Set(),
          view: { deviceId, managerId, available, board: null },
          loading: false,
          dirty: false,
        }
        boards.set(managerId, entry)
      }
      const first = entry.sinks.size === 0
      entry.sinks.add(sink)
      sink.snapshot(entry.view)
      if (first) void loadBoard(managerId, entry)
      const watched = entry
      return () => {
        watched.sinks.delete(sink)
        if (!watched.sinks.size) boards.delete(managerId)
      }
    },
    resync() {
      epoch++
      early = null
      for (const entry of boards.values()) {
        entry.loading = false
        entry.dirty = false
      }
      if (!host.supported()) {
        available = false
        managers.clear()
        snapshot()
        for (const entry of boards.values()) {
          entry.view = { ...entry.view, available: false, board: null }
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
    async submit(managerId: string, answers: ManagerSubmittedAnswer[]) {
      const result = await guarded(() =>
        host.request(MANAGER_METHOD.answersSubmit, { managerId, answers }),
      )
      invalidate(managerId)
      return projectManagerAnswers(result)
    },
    async reopen(params: ManagerDecisionReopenParams) {
      const result = await guarded(() => host.request(MANAGER_METHOD.decisionReopen, params))
      invalidate(params.managerId)
      return { decision: projectManagerDecision(result.decision) }
    },
  }
}
