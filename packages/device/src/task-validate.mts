// 定时任务的参数怎么校验、错误怎么回（deviceTasks 扩展，protocol/extensions/device-tasks.json）。
// 线上来的东西都当任意值看；不合格的回 invalidTask / invalidTarget，data.field 说是哪个字段。
import { isAbsolute } from 'node:path'
import {
  DEVICE_TASK_ERROR_CODE,
  type DeviceTask,
  type DeviceTaskErrorData,
  type DeviceTaskErrorReason,
  TASK_NAME_MAX,
  TASK_PROMPT_MAX,
  type TaskSessionSettings,
} from '../../protocol/src/device-tasks.mjs'
import { validateTaskSchedule } from '../../protocol/src/task-schedule.mjs'
import { isObject } from './wire.mjs'

/** 这个扩展自己回的错误：原因在 `error.data.litch` */
export class DeviceTaskError extends Error {
  readonly code: number
  readonly data: DeviceTaskErrorData

  constructor(
    reason: DeviceTaskErrorReason,
    message: string,
    detail: Omit<DeviceTaskErrorData, 'litch'> = {},
  ) {
    super(message)
    this.code = DEVICE_TASK_ERROR_CODE[reason]
    this.data = { litch: reason, ...detail }
  }
}

export const invalid = (field: string, message: string): DeviceTaskError =>
  new DeviceTaskError('invalidTask', message, { field })

export const badTarget = (field: string, message: string): DeviceTaskError =>
  new DeviceTaskError('invalidTarget', message, { field })

export const unknownTask = (id: string): DeviceTaskError =>
  new DeviceTaskError('unknownTask', `There is no task ${id} on this device`, { taskId: id })

export const conflict = (task: DeviceTask): DeviceTaskError =>
  new DeviceTaskError(
    'taskConflict',
    `Task ${task.id} was changed elsewhere (now at revision ${task.revision})`,
    { taskId: task.id, task },
  )

/** 名字：1–120 个字，不能全是空白 */
export function taskName(value: unknown, field = 'name'): string {
  if (typeof value !== 'string' || !value.trim())
    throw invalid(field, 'The name must be a non-empty string')
  if (value.length > TASK_NAME_MAX)
    throw invalid(field, `The name must be at most ${TASK_NAME_MAX} characters`)
  return value
}

/** 提示词：1–100000 个字，不能全是空白 */
export function taskPrompt(value: unknown, field = 'prompt'): string {
  if (typeof value !== 'string' || !value.trim())
    throw invalid(field, 'The prompt must be a non-empty string')
  if (value.length > TASK_PROMPT_MAX)
    throw invalid(field, `The prompt must be at most ${TASK_PROMPT_MAX} characters`)
  return value
}

/** 日程和时区：交给协议包里的算法判断，它说哪个字段不对就报哪个 */
export function checkSchedule(schedule: unknown, timezone: unknown): void {
  const problem = validateTaskSchedule(schedule, timezone)
  if (problem) throw invalid(problem.field, problem.message)
}

const optionalText = (value: unknown, field: string): string | null => {
  if (value == null) return null
  if (typeof value !== 'string') throw invalid(field, `${field} must be a string or null`)
  return value || null
}

/** 新会话用的设置 */
export function sessionSettings(value: unknown, field = 'target.settings'): TaskSessionSettings {
  if (value == null) return { model: null, effort: null, permission: null }
  if (!isObject(value)) throw invalid(field, `${field} must be an object`)
  return {
    model: optionalText(value.model, `${field}.model`),
    effort: optionalText(value.effort, `${field}.effort`),
    permission: optionalText(value.permission, `${field}.permission`),
  }
}

/** 设备上的绝对路径（存在不存在到跑的时候才看，那时没有记 cwdMissing） */
export function taskCwd(value: unknown, field = 'target.cwd'): string {
  if (typeof value !== 'string' || !isAbsolute(value))
    throw invalid(field, 'The working directory must be an absolute path on this device')
  return value
}

export function optionalStatus<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field = 'status',
): T | null {
  if (value == null) return null
  if (typeof value !== 'string' || !allowed.includes(value as T))
    throw invalid(field, `status must be one of ${allowed.join(', ')}`)
  return value as T
}

/** 非空字符串 */
export function requiredId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value)
    throw invalid(field, `${field} must be a non-empty string`)
  return value
}
