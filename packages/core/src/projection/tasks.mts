// 定时任务：设备给的（deviceTasks 扩展，时间是秒）投影成界面看的（时间是毫秒，带着设备标识），
// 和反过来把界面给的新建、修改换成请求的参数。
import type {
  DeviceTask,
  DeviceTaskCreateParams,
  DeviceTaskRun,
  DeviceTaskUpdateParams,
  TaskError,
} from '../../../protocol/src/device-tasks.mjs'
import type {
  SessionTaskMark,
  TaskDraft,
  TaskErrorView,
  TaskPatch,
  TaskRunView,
  TaskView,
} from '../model-tasks.mjs'

const ms = (seconds: number | null | undefined): number | null =>
  typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : null

const errorOf = (error: TaskError | null | undefined): TaskErrorView | null =>
  error ? { code: error.code, message: String(error.message ?? '') } : null

export function projectRun(deviceId: string, run: DeviceTaskRun): TaskRunView {
  return {
    id: run.id,
    taskId: run.taskId,
    deviceId,
    trigger: run.trigger === 'manual' ? 'manual' : 'scheduled',
    scheduledFor: ms(run.scheduledFor) ?? 0,
    coalesced: typeof run.coalesced === 'number' ? run.coalesced : 0,
    status: run.status,
    harness: run.harness,
    threadId: run.threadId ?? null,
    startedAt: ms(run.startedAt),
    finishedAt: ms(run.finishedAt),
    summary: run.summary ?? null,
    error: errorOf(run.error),
    // 没结束的总是“看过了”：协议这么约定，这里照着守一遍
    read: finishedRun(run.status) ? run.read !== false : true,
  }
}

export function projectTask(deviceId: string, task: DeviceTask): TaskView {
  return {
    id: task.id,
    deviceId,
    name: task.name,
    prompt: task.prompt,
    schedule: task.schedule,
    timezone: task.timezone,
    status: task.status,
    target: task.target,
    origin: task.origin,
    revision: task.revision,
    createdAt: ms(task.createdAt) ?? 0,
    updatedAt: ms(task.updatedAt) ?? 0,
    nextRunAt: ms(task.nextRunAt),
    lastRunAt: ms(task.lastRunAt),
    lastRun: task.lastRun ? projectRun(deviceId, task.lastRun) : null,
    lastError: errorOf(task.lastError),
    unreadRuns: typeof task.unreadRuns === 'number' ? task.unreadRuns : 0,
  }
}

/** 结束了的运行（成功、失败、取消） */
export const finishedRun = (status: TaskRunView['status']): boolean =>
  status === 'succeeded' || status === 'failed' || status === 'canceled'

export function createParams(draft: TaskDraft): DeviceTaskCreateParams {
  return {
    name: draft.name,
    prompt: draft.prompt,
    schedule: draft.schedule,
    ...(draft.timezone ? { timezone: draft.timezone } : {}),
    target: draft.target,
    ...(draft.status ? { status: draft.status } : {}),
  }
}

export function updateParams(
  id: string,
  revision: number,
  patch: TaskPatch,
): DeviceTaskUpdateParams {
  const params: DeviceTaskUpdateParams = { id, revision }
  if (patch.name !== undefined) params.name = patch.name
  if (patch.prompt !== undefined) params.prompt = patch.prompt
  if (patch.schedule !== undefined) params.schedule = patch.schedule
  if (patch.timezone !== undefined) params.timezone = patch.timezone
  if (patch.status !== undefined) params.status = patch.status
  if (patch.target !== undefined) params.target = patch.target
  return params
}

/**
 * 一个会话和定时任务的关系。target：有任务在这个会话里接着发；run：这个会话里跑过一次运行
 * （给的是最近的那一次）。两样都沾的算 target
 */
export function taskMark(
  threadId: string,
  tasks: Iterable<TaskView>,
  latestRun: TaskRunView | undefined,
): SessionTaskMark | null {
  for (const task of tasks) {
    if (task.target.kind === 'thread' && task.target.threadId === threadId) {
      return { kind: 'target', taskId: task.id }
    }
  }
  if (!latestRun) return null
  return {
    kind: 'run',
    taskId: latestRun.taskId,
    runId: latestRun.id,
    trigger: latestRun.trigger,
    scheduledFor: latestRun.scheduledFor,
  }
}

export const sameMark = (a: SessionTaskMark | null, b: SessionTaskMark | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b)
