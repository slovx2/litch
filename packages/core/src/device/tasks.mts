// 一台设备上的定时任务（协议扩展 deviceTasks）在客户端这一头的样子。
// 任务存在设备上、由设备服务按时执行，客户端断开也照样跑；核心只是转运，再跟着通知改。
//
// 数据流：连上（重连）之后取一遍全部任务和最近的运行记录（对账）；之后对面的通知是唯一的来源，不轮询。
// 数据副本对每台设备一直订阅着 tasks 主题：侧栏入口的未读合计、会话上的“定时”记号、
// 运行结束的系统通知都靠它。设备没列 deviceTasks 时照样给快照，available 是 false。
import {
  DEVICE_TASK_CHANGED,
  DEVICE_TASK_RUN_CHANGED,
  type DeviceTask,
  type DeviceTaskChangedNotification,
  type DeviceTaskErrorData,
  type DeviceTaskRunChangedNotification,
} from '../../../protocol/src/device-tasks.mjs'
import type { ClientRequestMethod, ClientRequests } from '../../../protocol/src/index.mjs'
import { ChannelError, type TasksOp } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import { RpcError, type RpcRequestOptions } from '../connection/rpc.mjs'
import type {
  SessionTaskMark,
  TaskDraft,
  TaskPatch,
  TaskRunView,
  TasksView,
  TaskView,
} from '../model-tasks.mjs'
import { phrase } from '../phrase.mjs'
import {
  createParams,
  finishedRun,
  projectRun,
  projectTask,
  sameMark,
  taskMark,
  updateParams,
} from '../projection/tasks.mjs'

export interface TasksHost {
  deviceId: string
  online(): boolean
  /** 对面支不支持定时任务：它是设备服务，而且设备信息的 extensions 里列了 deviceTasks */
  supported(): boolean
  request<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequests[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<ClientRequests[M]['result']>
  /** 请求没做成：换成给人看的错误 */
  fail(error: unknown): ChannelError
  /** 这几个会话和定时任务的关系变了：侧栏那几行要换 */
  marksChanged(threadIds: readonly string[]): void
  log(line: string): void
}

export interface Tasks {
  /** 订阅这台设备的定时任务。先给快照（没连上过时 available 是 null），之后给增量；返回退订函数 */
  open(sink: HostSink): () => void
  /** 连上并认出对面是谁了：全量对账一次 */
  resync(): void
  /** 连接断了：在途的结果都不算数了。手上的那份留着，连回来再换 */
  offline(): void
  /** 是定时任务的通知就处理掉并返回 true */
  notification(method: string, params: unknown): boolean
  /** 现在能不能用（连着，对面也支持） */
  usable(): boolean
  /** 这个会话和定时任务有什么关系。无关是 null */
  mark(threadId: string): SessionTaskMark | null
  /** 这个会话被打开了：在它里面跑完、还没看过的运行标成看过了 */
  seen(threadId: string): void
  create(draft: TaskDraft): Promise<TaskView>
  update(taskId: string, revision: number, patch: TaskPatch): Promise<TaskView>
  pause(taskId: string, paused: boolean): Promise<TaskView>
  remove(taskId: string): Promise<void>
  runNow(taskId: string): Promise<{ run: TaskRunView; deduplicated: boolean }>
  runs(
    taskId: string | null,
    cursor: string | null,
    limit: number | undefined,
  ): Promise<{ runs: TaskRunView[]; nextCursor: string | null }>
  markRead(taskId: string | undefined, runIds: string[] | undefined): Promise<void>
}

/** 对账时一起取的运行记录有多少条：用来认出哪些会话是任务跑出来的（更早的认不出，见交接说明） */
export const RECENT_RUNS = 200

const UNSUPPORTED = '这台设备的服务版本不支持定时任务'

/** 运行走到哪一步了：先后只用来挑“哪个是新的” */
const STAGE: Record<TaskRunView['status'], number> = {
  queued: 0,
  running: 1,
  succeeded: 2,
  failed: 2,
  canceled: 2,
}

/** 设备回的这个扩展自己的错误：原因在 error.data.litch 里 */
const taskFault = (error: unknown): DeviceTaskErrorData | null => {
  if (!(error instanceof RpcError)) return null
  const data = error.data as { litch?: unknown } | null | undefined
  const reason = data?.litch
  return typeof reason === 'string' &&
    ['unknownTask', 'taskConflict', 'invalidTask', 'invalidTarget', 'taskLimitReached'].includes(
      reason,
    )
    ? (data as DeviceTaskErrorData)
    : null
}

export function createTasks(host: TasksHost): Tasks {
  const { deviceId } = host
  const sinks = new Set<HostSink>()
  /** null：还没连上过，不知道 */
  let available: boolean | null = null
  /** 任务，按建的先后 */
  const tasks = new Map<string, TaskView>()
  /** 知道的运行（对账时取的最近那些、之后通知来的），按标识 */
  const runs = new Map<string, TaskRunView>()
  /** 会话 → 在它里面跑过的最近一次运行 */
  const latestByThread = new Map<string, TaskRunView>()
  /** 每次断开、每次重新对账换一个代号，在途的结果回来时对不上就作废 */
  let epoch = 0
  /** 对账途中到的通知：取完之后按顺序放 */
  let early: { method: string; params: unknown }[] | null = null
  /** 现在给出去的记号，用来知道哪些会话的变了 */
  const marks = new Map<string, SessionTaskMark>()

  const view = (): TasksView => ({ deviceId, available, tasks: [...tasks.values()] })

  const publish = (ops: TasksOp[]) => {
    for (const sink of sinks) sink.delta(ops)
  }

  const sorted = () => {
    const list = [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt)
    tasks.clear()
    for (const task of list) tasks.set(task.id, task)
  }

  /** 重新算各会话的记号，变了的报给设备（侧栏那几行跟着换） */
  const remark = () => {
    const threads = new Set<string>([...marks.keys(), ...latestByThread.keys()])
    for (const task of tasks.values()) {
      if (task.target.kind === 'thread') threads.add(task.target.threadId)
    }
    const changed: string[] = []
    for (const threadId of threads) {
      const next = taskMark(threadId, tasks.values(), latestByThread.get(threadId))
      const was = marks.get(threadId) ?? null
      if (sameMark(was, next)) continue
      if (next) marks.set(threadId, next)
      else marks.delete(threadId)
      changed.push(threadId)
    }
    if (changed.length > 0) host.marksChanged(changed)
  }

  /** 记下一次运行。比手上的旧的不要（先后按走到哪一步、看没看过）。返回之前知道的那一份 */
  const keepRun = (run: TaskRunView): TaskRunView | undefined => {
    const was = runs.get(run.id)
    if (was && (STAGE[was.status] > STAGE[run.status] || (was.read && !run.read))) return was
    runs.set(run.id, run)
    if (run.threadId) {
      const latest = latestByThread.get(run.threadId)
      if (!latest || latest.id === run.id || latest.scheduledFor <= run.scheduledFor) {
        latestByThread.set(run.threadId, run)
      }
    }
    return was
  }

  const forgetTask = (taskId: string) => {
    tasks.delete(taskId)
    for (const [id, run] of runs) if (run.taskId === taskId) runs.delete(id)
    for (const [threadId, run] of latestByThread) {
      if (run.taskId === taskId) latestByThread.delete(threadId)
    }
  }

  /** 换上一个任务。版本比手上的旧就不要。返回换上了没有 */
  const keepTask = (raw: DeviceTask): TaskView | null => {
    const next = projectTask(deviceId, raw)
    const was = tasks.get(next.id)
    if (was && was.revision > next.revision) return null
    tasks.set(next.id, next)
    if (!was) sorted()
    if (next.lastRun) keepRun(next.lastRun)
    return next
  }

  const changed = (note: DeviceTaskChangedNotification) => {
    if (note.change === 'deleted' || !note.task) {
      if (!tasks.has(note.taskId)) return
      forgetTask(note.taskId)
      publish([{ op: 'task.remove', taskId: note.taskId }])
      remark()
      return
    }
    const task = keepTask(note.task)
    if (!task) return
    publish([{ op: 'task.upsert', task }])
    remark()
  }

  const runChanged = (note: DeviceTaskRunChangedNotification) => {
    const run = projectRun(deviceId, note.run)
    // 删掉的任务跑完的那一次设备不再记，这边也不要
    if (!tasks.has(run.taskId)) return
    const was = keepRun(run)
    if (runs.get(run.id) !== run) return
    // 连着的时候看着它结束：头一次见到它是结束了的（没见过开始，比如很快就跑完）也算，
    // 但标成看过了的那种通知不算（打开看过之后设备会再发一遍）
    const finished = finishedRun(run.status) && !run.read && (!was || !finishedRun(was.status))
    publish([{ op: 'run.upsert', run, finished }])
    remark()
  }

  const route = (method: string, params: unknown) => {
    if (method === DEVICE_TASK_CHANGED) changed(params as DeviceTaskChangedNotification)
    else runChanged(params as DeviceTaskRunChangedNotification)
  }

  const snapshotAll = () => {
    const data = view()
    for (const sink of sinks) sink.snapshot(data)
  }

  const reconcile = async () => {
    const mine = ++epoch
    early = []
    try {
      const [listed, recent] = await Promise.all([
        host.request('litch/task/list', {}),
        host.request('litch/task/runs/list', { limit: RECENT_RUNS }),
      ])
      if (mine !== epoch) return
      tasks.clear()
      runs.clear()
      latestByThread.clear()
      for (const raw of listed.data) keepTask(raw)
      sorted()
      for (const raw of recent.data) {
        if (tasks.has(raw.taskId)) keepRun(projectRun(deviceId, raw))
      }
      available = true
      const pending = early ?? []
      early = null
      // 取的这一会儿里到的通知：比取到的新才用得上（keepTask、keepRun 自己会比）
      for (const entry of pending) {
        if (entry.method === DEVICE_TASK_CHANGED) {
          const note = entry.params as DeviceTaskChangedNotification
          if (note.change === 'deleted' || !note.task) forgetTask(note.taskId)
          else keepTask(note.task)
        } else {
          const run = projectRun(deviceId, (entry.params as DeviceTaskRunChangedNotification).run)
          if (tasks.has(run.taskId)) keepRun(run)
        }
      }
      snapshotAll()
      remark()
    } catch (error) {
      if (mine !== epoch) return
      early = null
      host.log(`取定时任务失败：${String(error)}`)
    }
  }

  const reachable = () => {
    if (!host.online()) throw new ChannelError('offline', '设备没有连上')
    if (!host.supported()) {
      throw new ChannelError('unsupported', UNSUPPORTED, phrase('tasks.unsupported'))
    }
  }

  /** 设备回的错误换成界面能用的形状。版本对不上时先把它带来的最新任务换上、发出去 */
  const failure = (error: unknown): ChannelError => {
    const fault = taskFault(error)
    const message = error instanceof Error ? error.message : String(error)
    switch (fault?.litch) {
      case 'unknownTask':
        return new ChannelError('notFound', message, phrase('tasks.gone'))
      case 'taskConflict': {
        const latest = fault.task ? keepTask(fault.task) : null
        if (latest) {
          publish([{ op: 'task.upsert', task: latest }])
          remark()
        }
        return new ChannelError('conflict', message, phrase('tasks.conflict'))
      }
      case 'invalidTask':
      case 'invalidTarget':
        return new ChannelError('invalid', message, undefined, {
          key: fault.field ?? (fault.litch === 'invalidTarget' ? 'target' : ''),
        })
      case 'taskLimitReached':
        return new ChannelError('rejected', message, phrase('tasks.limit'))
      default:
        return host.fail(error)
    }
  }

  const guarded = async <T,>(run: () => Promise<T>): Promise<T> => {
    reachable()
    try {
      return await run()
    } catch (error) {
      throw failure(error)
    }
  }

  /** 自己改成了：先把新的样子发出去，不等通知 */
  const settle = (raw: DeviceTask): TaskView => {
    const task = keepTask(raw) ?? tasks.get(raw.id) ?? projectTask(deviceId, raw)
    publish([{ op: 'task.upsert', task }])
    remark()
    return task
  }

  /** 标成看过了之后，手上那几条和任务的未读数先跟着改（设备随后也会发通知） */
  const readLocally = (taskId: string | undefined, runIds: readonly string[] | undefined) => {
    const ops: TasksOp[] = []
    const touched = new Map<string, number>()
    for (const run of runs.values()) {
      const hit = runIds ? runIds.includes(run.id) : taskId === undefined || run.taskId === taskId
      if (!hit || run.read || !finishedRun(run.status)) continue
      const next = { ...run, read: true }
      keepRun(next)
      ops.push({ op: 'run.upsert', run: next, finished: false })
      touched.set(run.taskId, (touched.get(run.taskId) ?? 0) + 1)
    }
    for (const task of tasks.values()) {
      const whole = !runIds && (taskId === undefined || task.id === taskId)
      const count = touched.get(task.id) ?? 0
      if (task.unreadRuns === 0 || (!whole && count === 0)) continue
      const next = { ...task, unreadRuns: whole ? 0 : Math.max(0, task.unreadRuns - count) }
      tasks.set(task.id, next)
      ops.push({ op: 'task.upsert', task: next })
    }
    if (ops.length > 0) publish(ops)
  }

  const markRead = async (taskId: string | undefined, runIds: string[] | undefined) => {
    await guarded(() =>
      host.request('litch/task/runs/markRead', {
        ...(taskId === undefined ? {} : { taskId }),
        ...(runIds === undefined ? {} : { runIds }),
      }),
    )
    readLocally(taskId, runIds)
  }

  return {
    open(sink) {
      sinks.add(sink)
      sink.snapshot(view())
      return () => {
        sinks.delete(sink)
      }
    },

    resync() {
      epoch++
      early = null
      if (!host.supported()) {
        // 这台设备的服务不支持：手上的（上一次连的可能是新版）都不算数了
        const had = new Set(marks.keys())
        tasks.clear()
        runs.clear()
        latestByThread.clear()
        available = false
        snapshotAll()
        if (had.size > 0) remark()
        return
      }
      void reconcile()
    },

    offline() {
      epoch++
      early = null
    },

    notification(method, params) {
      if (method !== DEVICE_TASK_CHANGED && method !== DEVICE_TASK_RUN_CHANGED) return false
      if (early) early.push({ method, params })
      else if (available) route(method, params)
      return true
    },

    usable: () => host.online() && host.supported(),

    mark: (threadId) => marks.get(threadId) ?? null,

    seen(threadId) {
      if (!host.online() || !host.supported()) return
      const unread = [...runs.values()].filter(
        (run) => run.threadId === threadId && !run.read && finishedRun(run.status),
      )
      if (unread.length === 0) return
      markRead(
        undefined,
        unread.map((run) => run.id),
      ).catch((error: unknown) => host.log(`标运行为看过失败：${String(error)}`))
    },

    async create(draft) {
      const { task } = await guarded(() => host.request('litch/task/create', createParams(draft)))
      return settle(task)
    },

    async update(taskId, revision, patch) {
      const { task } = await guarded(() =>
        host.request('litch/task/update', updateParams(taskId, revision, patch)),
      )
      return settle(task)
    },

    async pause(taskId, paused) {
      const status = paused ? 'paused' : 'active'
      // 撞上别处的改动（版本对不上）就按它带来的最新版本再试一次：暂停继续不怕覆盖别的字段
      for (let attempt = 0; ; attempt++) {
        const known = tasks.get(taskId)
        if (!known) throw new ChannelError('notFound', '没有这个任务', phrase('tasks.gone'))
        try {
          const { task } = await guarded(() =>
            host.request('litch/task/update', { id: taskId, revision: known.revision, status }),
          )
          return settle(task)
        } catch (error) {
          if (attempt > 0 || !(error instanceof ChannelError) || error.code !== 'conflict') {
            throw error
          }
        }
      }
    },

    async remove(taskId) {
      await guarded(() => host.request('litch/task/delete', { id: taskId }))
      if (!tasks.has(taskId)) return
      forgetTask(taskId)
      publish([{ op: 'task.remove', taskId }])
      remark()
    },

    async runNow(taskId) {
      const result = await guarded(() => host.request('litch/task/runNow', { id: taskId }))
      const run = projectRun(deviceId, result.run)
      if (tasks.has(run.taskId)) {
        keepRun(run)
        publish([{ op: 'run.upsert', run: runs.get(run.id) ?? run, finished: false }])
        remark()
      }
      return { run, deduplicated: result.deduplicated === true }
    },

    async runs(taskId, cursor, limit) {
      const result = await guarded(() =>
        host.request('litch/task/runs/list', {
          ...(taskId === null ? {} : { taskId }),
          ...(cursor ? { cursor } : {}),
          ...(limit === undefined ? {} : { limit }),
        }),
      )
      return {
        runs: result.data.map((raw) => projectRun(deviceId, raw)),
        nextCursor: result.nextCursor ?? null,
      }
    },

    markRead,
  }
}
