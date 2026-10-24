// 模拟核心的定时任务：订阅、建、改、暂停继续、删、立即运行、运行记录、标成看过。
// 行为照真的设备服务和真的核心：版本对不上回冲突（最新的先经订阅发出去）、同一任务同时只有一次运行、
// 结束的运行算未读、打开它跑出来的会话就算看过。立即运行会真的演一次：排队、开会话跑一个回合、结束；
// 提示词里带“失败”（英文 fail）的那一次会失败。按日程到点自己跑这里不演。
import { TASK_NAME_MAX, TASK_PROMPT_MAX } from '../../../protocol/src/device-tasks.mjs'
import {
  localTaskTimeZone,
  nextTaskRun,
  validateTaskSchedule,
} from '../../../protocol/src/task-schedule.mjs'
import { ChannelError, type Clock, type Commands, type TasksOp } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import type { DeviceView } from '../model.mjs'
import type { SessionTaskMark, TaskRunView, TasksView, TaskView } from '../model-tasks.mjs'
import { phrase } from '../phrase.mjs'
import { finishedRun, sameMark, taskMark } from '../projection/tasks.mjs'
import { FAILS_RUN, sampleTaskAnswer, sampleTasks } from './sample-tasks.mjs'
import type { SampleLang } from './sample-text.mjs'

export interface MockTasksHost {
  clock: Clock
  /** 演一次运行时每一步隔多久的基数；0 表示不拖时间 */
  stepMs: number
  lang: SampleLang
  device(deviceId: string): DeviceView | undefined
  /** 一开始就有的那几台设备 */
  devices(): DeviceView[]
  /** 在设备上新建一个会话（放进侧栏），返回它的标识 */
  spawn(
    deviceId: string,
    init: { harness: string; cwd: string; workspaceId: string | null; title: string },
  ): string
  /** 往会话里加一个跑完了的回合：发的话和回答（失败的回合没有回答） */
  say(deviceId: string, sessionId: string, prompt: string, answer: string | null): void
  /** 侧栏里有没有这个会话 */
  hasSession(deviceId: string, sessionId: string): boolean
  /** 会话和定时任务的关系变了 */
  mark(deviceId: string, sessionId: string, mark: SessionTaskMark | null): void
}

export interface MockTasks {
  subscribe(deviceId: string, sink: HostSink): () => void
  /** 是定时任务的命令就处理；不是就返回 undefined，交给别处 */
  command(name: string, params: unknown): Promise<unknown> | undefined
  /** 侧栏一开始就该带着的记号：会话 → 和哪个任务有关 */
  marks(deviceId: string): Map<string, SessionTaskMark>
  /** 会话被打开了：在它里面跑完、还没看过的运行标成看过了 */
  seen(deviceId: string, sessionId: string): void
}

const NAMES: readonly string[] = [
  'tasks.create',
  'tasks.update',
  'tasks.pause',
  'tasks.delete',
  'tasks.runNow',
  'tasks.runs',
  'tasks.markRead',
]

/** 运行记录一页多少条，和设备服务的默认一样 */
const PAGE = 50

interface DeviceTasks {
  tasks: Map<string, TaskView>
  /** 新的在前 */
  runs: TaskRunView[]
  marks: Map<string, SessionTaskMark>
}

const pad = (value: number): string => String(value).padStart(2, '0')
/** 运行跑出来的会话叫“任务名 · 月-日 时:分”，和设备服务的叫法一样 */
const stamp = (ms: number): string => {
  const date = new Date(ms)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function createMockTasks(host: MockTasksHost): MockTasks {
  const { clock } = host
  const states = new Map<string, DeviceTasks>()
  const sinks = new Map<string, Set<HostSink>>()
  let seq = 0
  const later = (run: () => void, steps: number) =>
    clock.setTimer(run, Math.max(host.stepMs * steps, 1))

  /** 这台设备支不支持：完整模式的才支持（示例里只有原生 codex 的 nas 不支持）；还没连上过的不知道 */
  const availableOf = (device: DeviceView): boolean | null =>
    device.mode !== 'full' ? false : device.stale ? null : true

  const stateOf = (deviceId: string): DeviceTasks => {
    let state = states.get(deviceId)
    if (!state) {
      const device = host.device(deviceId)
      const sample =
        device && availableOf(device) === true
          ? sampleTasks(deviceId, clock.now(), host.lang)
          : { tasks: [], runs: [] }
      state = {
        tasks: new Map(sample.tasks.map((task) => [task.id, task])),
        runs: sample.runs,
        marks: new Map(),
      }
      states.set(deviceId, state)
      remark(deviceId, state, false)
    }
    return state
  }

  /** 重新算各会话的记号。tell：变了的告诉模拟核心（一开始的那一次由模拟核心自己摆进侧栏） */
  function remark(deviceId: string, state: DeviceTasks, tell: boolean) {
    const latest = new Map<string, TaskRunView>()
    for (const run of state.runs) {
      if (run.threadId && !latest.has(run.threadId)) latest.set(run.threadId, run)
    }
    const threads = new Set([...state.marks.keys(), ...latest.keys()])
    for (const task of state.tasks.values()) {
      if (task.target.kind === 'thread') threads.add(task.target.threadId)
    }
    for (const threadId of threads) {
      const next = taskMark(threadId, state.tasks.values(), latest.get(threadId))
      const was = state.marks.get(threadId) ?? null
      if (sameMark(was, next)) continue
      if (next) state.marks.set(threadId, next)
      else state.marks.delete(threadId)
      if (tell && host.hasSession(deviceId, threadId)) host.mark(deviceId, threadId, next)
    }
  }

  const publish = (deviceId: string, ops: TasksOp[]) => {
    for (const sink of sinks.get(deviceId) ?? []) sink.delta(ops)
  }

  const viewOf = (deviceId: string): TasksView => {
    const device = host.device(deviceId)
    if (!device) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
    const state = stateOf(deviceId)
    return {
      deviceId,
      available: availableOf(device),
      tasks: [...state.tasks.values()].sort((a, b) => a.createdAt - b.createdAt),
    }
  }

  const reach = (deviceId: string): DeviceTasks => {
    const device = host.device(deviceId)
    if (!device) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
    if (device.connection !== 'online') throw new ChannelError('offline', '设备没有连上')
    if (availableOf(device) !== true) {
      throw new ChannelError(
        'unsupported',
        '这台设备的服务版本不支持定时任务',
        phrase('tasks.unsupported'),
      )
    }
    return stateOf(deviceId)
  }

  const taskOf = (state: DeviceTasks, taskId: string): TaskView => {
    const task = state.tasks.get(taskId)
    if (!task) throw new ChannelError('notFound', '没有这个任务', phrase('tasks.gone'))
    return task
  }

  /** 名字、提示词、日程不对时和设备服务一样回 invalid，说是哪个字段 */
  const check = (fields: {
    name?: string
    prompt?: string
    schedule?: unknown
    timezone?: string
  }) => {
    const name = fields.name?.trim()
    if (fields.name !== undefined && (!name || name.length > TASK_NAME_MAX)) {
      throw new ChannelError('invalid', 'name must be 1–120 characters', undefined, { key: 'name' })
    }
    const prompt = fields.prompt?.trim()
    if (fields.prompt !== undefined && (!prompt || fields.prompt.length > TASK_PROMPT_MAX)) {
      throw new ChannelError('invalid', 'prompt must not be empty', undefined, { key: 'prompt' })
    }
    if (fields.schedule !== undefined || fields.timezone !== undefined) {
      const problem = validateTaskSchedule(fields.schedule, fields.timezone)
      if (problem)
        throw new ChannelError('invalid', problem.message, undefined, { key: problem.field })
    }
  }

  /** 按日程算下一次。暂停了、跑完了的没有 */
  const nextOf = (task: TaskView, anchor: number): number | null => {
    if (task.status !== 'active') return null
    const next = nextTaskRun(
      task.schedule,
      task.timezone,
      Math.floor(clock.now() / 1000),
      Math.floor(anchor / 1000),
    )
    return next === null ? null : next * 1000
  }

  /** 换上一个任务的新样子，发出去 */
  const putTask = (deviceId: string, state: DeviceTasks, task: TaskView) => {
    state.tasks.set(task.id, task)
    publish(deviceId, [{ op: 'task.upsert', task }])
  }

  /** 一次运行变了：换进记录、任务的最近一次跟着变，发出去 */
  const putRun = (deviceId: string, state: DeviceTasks, run: TaskRunView, finished: boolean) => {
    const at = state.runs.findIndex((entry) => entry.id === run.id)
    if (at < 0) state.runs.unshift(run)
    else state.runs[at] = run
    const task = state.tasks.get(run.taskId)
    const ops: TasksOp[] = [{ op: 'run.upsert', run, finished }]
    if (task) {
      const last = state.runs.find((entry) => entry.taskId === task.id) ?? null
      const next: TaskView = {
        ...task,
        lastRun: last,
        lastRunAt: last?.startedAt ?? last?.scheduledFor ?? null,
        ...(finished ? { lastError: run.status === 'failed' ? run.error : null } : {}),
        unreadRuns: state.runs.filter((entry) => entry.taskId === task.id && !entry.read).length,
      }
      state.tasks.set(task.id, next)
      ops.push({ op: 'task.upsert', task: next })
    }
    publish(deviceId, ops)
    remark(deviceId, state, true)
  }

  /** 演一次运行：排一小会儿队、开会话跑一个回合、结束 */
  const play = (deviceId: string, state: DeviceTasks, task: TaskView, run: TaskRunView) => {
    later(() => {
      if (!state.tasks.has(task.id)) return
      const threadId =
        task.target.kind === 'thread'
          ? task.target.threadId
          : host.spawn(deviceId, {
              harness: task.target.harness,
              cwd: task.target.cwd,
              workspaceId: task.target.workspaceId,
              title: `${task.name} · ${stamp(run.scheduledFor)}`,
            })
      const running: TaskRunView = { ...run, status: 'running', threadId, startedAt: clock.now() }
      putRun(deviceId, state, running, false)
      later(() => {
        if (!state.tasks.has(task.id)) return
        const failed = FAILS_RUN.test(task.prompt)
        const text = sampleTaskAnswer(host.lang)
        host.say(deviceId, threadId, task.prompt, failed ? null : text.answer)
        putRun(
          deviceId,
          state,
          {
            ...running,
            status: failed ? 'failed' : 'succeeded',
            finishedAt: clock.now(),
            summary: failed ? null : text.answer,
            error: failed ? { code: 'turnFailed', message: text.failed } : null,
            read: false,
          },
          true,
        )
      }, 12)
    }, 4)
  }

  const markRead = (deviceId: string, state: DeviceTasks, taskId?: string, runIds?: string[]) => {
    for (const run of [...state.runs]) {
      const hit = runIds ? runIds.includes(run.id) : taskId === undefined || run.taskId === taskId
      if (!hit || run.read || !finishedRun(run.status)) continue
      putRun(deviceId, state, { ...run, read: true }, false)
    }
  }

  const commands = {
    'tasks.create'(params: Commands['tasks.create']['params']) {
      const state = reach(params.deviceId)
      const draft = params.task
      // 不给时区是设备所在的时区：本机就是这台电脑的，示例里别的设备当它们在 UTC
      const timezone = draft.timezone ?? (params.deviceId === 'local' ? localTaskTimeZone() : 'UTC')
      check({ name: draft.name, prompt: draft.prompt, schedule: draft.schedule, timezone })
      if (
        draft.target.kind === 'thread' &&
        !host.hasSession(params.deviceId, draft.target.threadId)
      ) {
        throw new ChannelError('invalid', 'thread not found', undefined, { key: 'target.threadId' })
      }
      const now = clock.now()
      const base: TaskView = {
        id: `task-new-${++seq}`,
        deviceId: params.deviceId,
        name: draft.name.trim(),
        prompt: draft.prompt,
        schedule: draft.schedule,
        timezone,
        status: draft.status ?? 'active',
        target: draft.target,
        origin: { kind: 'client' },
        revision: 1,
        createdAt: now,
        updatedAt: now,
        nextRunAt: null,
        lastRunAt: null,
        lastRun: null,
        lastError: null,
        unreadRuns: 0,
      }
      const task = { ...base, nextRunAt: nextOf(base, now) }
      putTask(params.deviceId, state, task)
      remark(params.deviceId, state, true)
      return { task }
    },

    'tasks.update'(params: Commands['tasks.update']['params']) {
      const state = reach(params.deviceId)
      const task = taskOf(state, params.taskId)
      if (task.revision !== params.revision) {
        // 和真的核心一样：最新的样子已经在界面手里了
        publish(params.deviceId, [{ op: 'task.upsert', task }])
        throw new ChannelError('conflict', 'revision mismatch', phrase('tasks.conflict'))
      }
      const { patch } = params
      const schedule = patch.schedule ?? task.schedule
      const timezone = patch.timezone ?? task.timezone
      check({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.prompt === undefined ? {} : { prompt: patch.prompt }),
        ...(patch.schedule === undefined && patch.timezone === undefined
          ? {}
          : { schedule, timezone }),
      })
      if (patch.target && task.target.kind !== 'newThread') {
        throw new ChannelError('invalid', 'target of a thread task cannot change', undefined, {
          key: 'target',
        })
      }
      const target =
        patch.target && task.target.kind === 'newThread'
          ? {
              ...task.target,
              ...(patch.target.cwd === undefined ? {} : { cwd: patch.target.cwd }),
              ...(patch.target.workspaceId === undefined
                ? {}
                : { workspaceId: patch.target.workspaceId }),
              ...(patch.target.settings === undefined ? {} : { settings: patch.target.settings }),
            }
          : task.target
      const now = clock.now()
      const timing =
        patch.schedule !== undefined || patch.timezone !== undefined || patch.status !== undefined
      const next: TaskView = {
        ...task,
        ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
        ...(patch.prompt === undefined ? {} : { prompt: patch.prompt }),
        schedule,
        timezone,
        status: patch.status ?? task.status,
        target,
        revision: task.revision + 1,
        updatedAt: now,
      }
      const settled = timing ? { ...next, nextRunAt: nextOf(next, now) } : next
      putTask(params.deviceId, state, settled)
      return { task: settled }
    },

    'tasks.pause'(params: Commands['tasks.pause']['params']) {
      const state = reach(params.deviceId)
      const task = taskOf(state, params.taskId)
      return commands['tasks.update']({
        deviceId: params.deviceId,
        taskId: task.id,
        revision: task.revision,
        patch: { status: params.paused ? 'paused' : 'active' },
      })
    },

    'tasks.delete'(params: Commands['tasks.delete']['params']) {
      const state = reach(params.deviceId)
      taskOf(state, params.taskId)
      state.tasks.delete(params.taskId)
      state.runs = state.runs.filter((run) => run.taskId !== params.taskId)
      publish(params.deviceId, [{ op: 'task.remove', taskId: params.taskId }])
      remark(params.deviceId, state, true)
      return {}
    },

    'tasks.runNow'(params: Commands['tasks.runNow']['params']) {
      const state = reach(params.deviceId)
      const task = taskOf(state, params.taskId)
      const going = state.runs.find(
        (run) => run.taskId === task.id && (run.status === 'queued' || run.status === 'running'),
      )
      if (going) return { run: going, deduplicated: true }
      const run: TaskRunView = {
        id: `run-new-${++seq}`,
        taskId: task.id,
        deviceId: params.deviceId,
        trigger: 'manual',
        scheduledFor: clock.now(),
        coalesced: 0,
        status: 'queued',
        harness: task.target.harness,
        threadId: null,
        startedAt: null,
        finishedAt: null,
        summary: null,
        error: null,
        read: true,
        approvals: [],
      }
      putRun(params.deviceId, state, run, false)
      play(params.deviceId, state, task, run)
      return { run, deduplicated: false }
    },

    'tasks.runs'(params: Commands['tasks.runs']['params']) {
      const state = reach(params.deviceId)
      const list = state.runs.filter(
        (run) => params.taskId === null || run.taskId === params.taskId,
      )
      const start = params.cursor ? Number(params.cursor) : 0
      const limit = Math.min(params.limit ?? PAGE, 200)
      const page = list.slice(start, start + limit)
      return {
        runs: page,
        nextCursor: start + limit < list.length ? String(start + limit) : null,
      }
    },

    'tasks.markRead'(params: Commands['tasks.markRead']['params']) {
      const state = reach(params.deviceId)
      markRead(params.deviceId, state, params.taskId, params.runIds)
      return {}
    },
  }

  return {
    subscribe(deviceId, sink) {
      sink.snapshot(viewOf(deviceId))
      const set = sinks.get(deviceId) ?? new Set<HostSink>()
      sinks.set(deviceId, set)
      set.add(sink)
      return () => {
        set.delete(sink)
      }
    },

    command(name, params) {
      if (!NAMES.includes(name)) return undefined
      const run = commands[name as keyof typeof commands] as (params: unknown) => unknown
      // 和别的模拟命令一样稍等一下再应答，界面上看得到“正在做”
      return new Promise((resolve, reject) => {
        later(() => {
          try {
            resolve(run(params))
          } catch (error) {
            reject(error)
          }
        }, 1)
      })
    },

    marks(deviceId) {
      return new Map(stateOf(deviceId).marks)
    },

    seen(deviceId, sessionId) {
      const device = host.device(deviceId)
      if (!device || availableOf(device) !== true) return
      const state = stateOf(deviceId)
      const unread = state.runs
        .filter((run) => run.threadId === sessionId && !run.read && finishedRun(run.status))
        .map((run) => run.id)
      if (unread.length > 0) markRead(deviceId, state, undefined, unread)
    },
  }
}
