// 测试用的假定时任务接口（协议扩展 deviceTasks）：照设备服务的应答形状和错误形状应答。
// 方法表并进假聚合面的那一份里用。时间是秒，和协议一样。
import type {
  DeviceTask,
  DeviceTaskCreateParams,
  DeviceTaskIdParams,
  DeviceTaskRun,
  DeviceTaskRunsListParams,
  DeviceTaskRunsMarkReadParams,
  DeviceTaskUpdateParams,
} from '../../protocol/src/index.mjs'
import { type Handler, RpcFailure } from './fake-server.mjs'

export function rawTask(id: string, fields: Partial<DeviceTask> = {}): DeviceTask {
  return {
    id,
    name: `任务 ${id}`,
    prompt: '看一眼',
    schedule: { type: 'daily', time: '09:00' },
    timezone: 'Asia/Shanghai',
    status: 'active',
    target: {
      kind: 'newThread',
      harness: 'pi',
      cwd: '/work',
      workspaceId: null,
      settings: { model: null, effort: null, permission: null },
    },
    origin: { kind: 'client' },
    revision: 1,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    nextRunAt: 1_700_050_000,
    lastRunAt: null,
    lastRun: null,
    lastError: null,
    unreadRuns: 0,
    ...fields,
  }
}

export function rawRun(
  id: string,
  taskId: string,
  fields: Partial<DeviceTaskRun> = {},
): DeviceTaskRun {
  return {
    id,
    taskId,
    trigger: 'scheduled',
    scheduledFor: 1_700_000_100,
    coalesced: 0,
    status: 'succeeded',
    harness: 'pi',
    threadId: null,
    turnId: null,
    startedAt: 1_700_000_100,
    finishedAt: 1_700_000_200,
    summary: null,
    error: null,
    read: true,
    ...fields,
  }
}

export interface FakeTasks {
  tasks: DeviceTask[]
  /** 新的在前 */
  runs: DeviceTaskRun[]
  /** 收到过的请求：方法 → 参数，按到达顺序 */
  calls: { method: string; params: unknown }[]
  /** 运行记录一页几条 */
  pageSize: number
}

const failure = (code: number, message: string, data: Record<string, unknown>) =>
  new RpcFailure(code, message, data)

export function fakeTasks(): { state: FakeTasks; handlers: Record<string, Handler> } {
  const state: FakeTasks = { tasks: [], runs: [], calls: [], pageSize: 50 }
  let seq = 0
  const record = (method: string, params: unknown) => state.calls.push({ method, params })
  const find = (id: string): DeviceTask => {
    const task = state.tasks.find((entry) => entry.id === id)
    if (!task) throw failure(-32602, `unknown task ${id}`, { litch: 'unknownTask', taskId: id })
    return task
  }
  const handlers: Record<string, Handler> = {
    'litch/task/list': (params) => {
      record('litch/task/list', params)
      return { data: structuredClone(state.tasks) }
    },
    'litch/task/create': (params) => {
      record('litch/task/create', params)
      const given = params as DeviceTaskCreateParams
      if (!given.name) {
        throw failure(-32602, 'name is empty', { litch: 'invalidTask', field: 'name' })
      }
      const task = rawTask(`t${++seq}`, {
        name: given.name,
        prompt: given.prompt,
        schedule: given.schedule,
        timezone: given.timezone ?? 'Asia/Shanghai',
        target: given.target,
        status: given.status ?? 'active',
      })
      state.tasks.push(task)
      return { task: structuredClone(task) }
    },
    'litch/task/update': (params) => {
      record('litch/task/update', params)
      const given = params as DeviceTaskUpdateParams
      const task = find(given.id)
      if (task.revision !== given.revision) {
        throw failure(-32600, 'revision mismatch', {
          litch: 'taskConflict',
          taskId: task.id,
          task: structuredClone(task),
        })
      }
      if (given.name !== undefined) task.name = given.name
      if (given.status !== undefined) task.status = given.status
      if (given.schedule !== undefined) task.schedule = given.schedule
      task.revision++
      return { task: structuredClone(task) }
    },
    'litch/task/delete': (params) => {
      record('litch/task/delete', params)
      const { id } = params as DeviceTaskIdParams
      find(id)
      state.tasks = state.tasks.filter((entry) => entry.id !== id)
      state.runs = state.runs.filter((entry) => entry.taskId !== id)
      return {}
    },
    'litch/task/runNow': (params) => {
      record('litch/task/runNow', params)
      const { id } = params as DeviceTaskIdParams
      find(id)
      const going = state.runs.find(
        (run) => run.taskId === id && (run.status === 'queued' || run.status === 'running'),
      )
      if (going) return { run: structuredClone(going), deduplicated: true }
      const run = rawRun(`r${++seq}`, id, {
        trigger: 'manual',
        status: 'queued',
        startedAt: null,
        finishedAt: null,
      })
      state.runs.unshift(run)
      return { run: structuredClone(run), deduplicated: false }
    },
    'litch/task/runs/list': (params) => {
      record('litch/task/runs/list', params)
      const given = (params ?? {}) as DeviceTaskRunsListParams
      const list = state.runs.filter((run) => !given.taskId || run.taskId === given.taskId)
      const start = given.cursor ? Number(given.cursor) : 0
      const limit = given.limit ?? state.pageSize
      return {
        data: structuredClone(list.slice(start, start + limit)),
        nextCursor: start + limit < list.length ? String(start + limit) : null,
      }
    },
    'litch/task/runs/markRead': (params) => {
      record('litch/task/runs/markRead', params)
      const given = params as DeviceTaskRunsMarkReadParams
      for (const run of state.runs) {
        if (
          given.runIds
            ? given.runIds.includes(run.id)
            : !given.taskId || run.taskId === given.taskId
        ) {
          run.read = true
        }
      }
      return {}
    },
  }
  return { state, handlers }
}
