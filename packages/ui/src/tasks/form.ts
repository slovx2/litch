// 定时任务的表单：表单里的样子、和任务之间怎么换、界面这一侧先查的几样。
// 纯函数，不依赖 React 和页面：界面测试直接引，移动端也可以按相对路径引来用。
// 设备那一头还会再查一遍（名字长短、日程、时区、目标），这边先查出来是为了当场在那一栏下面说。
import type {
  TaskDraft,
  TaskPatch,
  TaskSchedule,
  TaskSessionSettings,
  TaskTarget,
  TaskView,
  TaskWeekday,
} from '@litch/core'
import type { MessageKey } from '../i18n/index.ts'

/** 表单上“多久一次”的几种，排在选择器里的顺序 */
export const REPEATS = [
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'hourly',
  'interval',
  'once',
] as const
export type Repeat = (typeof REPEATS)[number]

export interface TaskForm {
  name: string
  prompt: string
  repeat: Repeat
  /** daily、weekdays、weekly、monthly 的时刻 */
  time: string
  /** weekly 的星期 */
  days: TaskWeekday[]
  /** monthly 的几号 */
  monthDay: number
  /** interval：隔几分钟 */
  minutes: number
  /** hourly：隔几小时、第几分、只在哪几天（空是每天） */
  hours: number
  minute: number
  hourlyDays: TaskWeekday[]
  /** once：日期和时刻，YYYY-MM-DDTHH:MM（datetime-local 的写法） */
  at: string
  /** null：用设备的时区 */
  timezone: string | null
  target: 'newThread' | 'thread'
  deviceId: string
  harness: string
  workspaceId: string | null
  /** 不属于工作区时自己填的目录；属于工作区时是工作区的根 */
  cwd: string
  settings: TaskSessionSettings
  /** 在哪个会话里接着发 */
  threadId: string | null
  /** 建好之后先暂停（只在新建时有） */
  paused: boolean
}

/** 校验没过的那一栏和怎么说 */
export type FormProblems = Partial<Record<FormField, MessageKey>>
export type FormField =
  | 'name'
  | 'prompt'
  | 'time'
  | 'days'
  | 'monthDay'
  | 'minutes'
  | 'hours'
  | 'minute'
  | 'at'
  | 'timezone'
  | 'cwd'
  | 'threadId'

/** 名字的长度上限，和设备那一头一样 */
export const NAME_MAX = 120
/** 相邻两次最少隔几分钟，和设备那一头一样 */
export const MIN_MINUTES = 5

const pad = (value: number): string => String(value).padStart(2, '0')

/** 一个时刻（毫秒）在这台电脑上的 YYYY-MM-DDTHH:MM */
export function localWall(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 新建时的样子。once 默认是明天这个时候（整点） */
export function blankForm(place: {
  deviceId: string
  harness: string
  workspaceId: string | null
  cwd: string
  threadId?: string | null
  now?: number
}): TaskForm {
  const now = place.now ?? Date.now()
  const tomorrow = new Date(now + 86_400_000)
  tomorrow.setMinutes(0, 0, 0)
  return {
    name: '',
    prompt: '',
    repeat: 'daily',
    time: '09:00',
    days: ['MO'],
    monthDay: 1,
    minutes: 30,
    hours: 2,
    minute: 0,
    hourlyDays: [],
    at: localWall(tomorrow.getTime()),
    timezone: null,
    target: place.threadId ? 'thread' : 'newThread',
    deviceId: place.deviceId,
    harness: place.harness,
    workspaceId: place.workspaceId,
    cwd: place.cwd,
    settings: { model: null, effort: null, permission: null },
    threadId: place.threadId ?? null,
    paused: false,
  }
}

/** 已有的任务换成表单的样子（编辑时）。没用到的那几种日程的栏留默认值 */
export function formOf(task: TaskView): TaskForm {
  const form = blankForm({
    deviceId: task.deviceId,
    harness: task.target.harness,
    workspaceId: task.target.kind === 'newThread' ? task.target.workspaceId : null,
    cwd: task.target.kind === 'newThread' ? task.target.cwd : '',
    threadId: task.target.kind === 'thread' ? task.target.threadId : null,
  })
  const schedule = task.schedule
  const base: TaskForm = {
    ...form,
    name: task.name,
    prompt: task.prompt,
    repeat: schedule.type,
    timezone: task.timezone,
    target: task.target.kind,
    settings: task.target.kind === 'newThread' ? { ...task.target.settings } : form.settings,
  }
  switch (schedule.type) {
    case 'once':
      return { ...base, at: schedule.at }
    case 'interval':
      return { ...base, minutes: schedule.minutes }
    case 'hourly':
      return {
        ...base,
        hours: schedule.intervalHours,
        minute: schedule.minute,
        hourlyDays: schedule.days ? [...schedule.days] : [],
      }
    case 'daily':
    case 'weekdays':
      return { ...base, time: schedule.time }
    case 'weekly':
      return { ...base, time: schedule.time, days: [...schedule.days] }
    case 'monthly':
      return { ...base, time: schedule.time, monthDay: schedule.day }
  }
}

/** 表单上的日程换成协议的样子 */
export function scheduleOf(form: TaskForm): TaskSchedule {
  switch (form.repeat) {
    case 'once':
      return { type: 'once', at: form.at.slice(0, 16) }
    case 'interval':
      return { type: 'interval', minutes: form.minutes }
    case 'hourly':
      return {
        type: 'hourly',
        intervalHours: form.hours,
        minute: form.minute,
        days:
          form.hourlyDays.length > 0 && form.hourlyDays.length < 7
            ? sortDays(form.hourlyDays)
            : null,
      }
    case 'daily':
      return { type: 'daily', time: form.time }
    case 'weekdays':
      return { type: 'weekdays', time: form.time }
    case 'weekly':
      return { type: 'weekly', days: sortDays(form.days), time: form.time }
    case 'monthly':
      return { type: 'monthly', day: form.monthDay, time: form.time }
  }
}

const ORDER: readonly TaskWeekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const sortDays = (days: readonly TaskWeekday[]): TaskWeekday[] =>
  ORDER.filter((day) => days.includes(day))

/** 挑上或去掉一天 */
export function toggleDay(days: readonly TaskWeekday[], day: TaskWeekday): TaskWeekday[] {
  return days.includes(day) ? days.filter((entry) => entry !== day) : sortDays([...days, day])
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const AT = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d$/
const whole = (value: number, low: number, high: number) =>
  Number.isInteger(value) && value >= low && value <= high

/**
 * 界面这一侧先查的几样。zoneKnown：这台电脑认不认识这个时区名（时区是 null 时不问）。
 * 只查这一次要用到的那几栏
 */
export function checkForm(
  form: TaskForm,
  zoneKnown: (zone: string) => boolean,
  editing = false,
): FormProblems {
  const problems: FormProblems = {}
  const name = form.name.trim()
  if (!name || name.length > NAME_MAX) problems.name = 'tasks.check.name'
  if (!form.prompt.trim()) problems.prompt = 'tasks.check.prompt'
  const timed = form.repeat === 'daily' || form.repeat === 'weekdays' || form.repeat === 'weekly'
  if ((timed || form.repeat === 'monthly') && !TIME.test(form.time))
    problems.time = 'tasks.check.time'
  if (form.repeat === 'weekly' && form.days.length === 0) problems.days = 'tasks.check.days'
  if (form.repeat === 'monthly' && !whole(form.monthDay, 1, 31)) {
    problems.monthDay = 'tasks.check.monthDay'
  }
  if (
    form.repeat === 'interval' &&
    !(Number.isInteger(form.minutes) && form.minutes >= MIN_MINUTES)
  ) {
    problems.minutes = 'tasks.check.minutes'
  }
  if (form.repeat === 'hourly') {
    if (!whole(form.hours, 1, 23)) problems.hours = 'tasks.check.hours'
    if (!whole(form.minute, 0, 59)) problems.minute = 'tasks.check.minute'
  }
  if (form.repeat === 'once' && !AT.test(form.at.slice(0, 16))) problems.at = 'tasks.check.at'
  if (form.timezone !== null && !zoneKnown(form.timezone)) problems.timezone = 'tasks.check.zone'
  // 目标：编辑时 kind、会话都换不了，只查新建会话的工作目录
  if (form.target === 'newThread' && !form.cwd.trim()) problems.cwd = 'tasks.check.cwd'
  if (!editing && form.target === 'thread' && !form.threadId)
    problems.threadId = 'tasks.check.session'
  return problems
}

/** 表单上的目标换成协议的样子 */
export function targetOf(form: TaskForm): TaskTarget {
  return form.target === 'thread'
    ? { kind: 'thread', harness: form.harness, threadId: form.threadId ?? '' }
    : {
        kind: 'newThread',
        harness: form.harness,
        cwd: form.cwd.trim(),
        workspaceId: form.workspaceId,
        settings: { ...form.settings },
      }
}

/** 新建时发的 */
export function draftOf(form: TaskForm): TaskDraft {
  return {
    name: form.name.trim(),
    prompt: form.prompt,
    schedule: scheduleOf(form),
    timezone: form.timezone,
    target: targetOf(form),
    ...(form.paused ? { status: 'paused' as const } : {}),
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** 编辑时发的：只带改了的那几项。一项都没改是 null */
export function patchOf(task: TaskView, form: TaskForm): TaskPatch | null {
  const patch: TaskPatch = {}
  const name = form.name.trim()
  if (name !== task.name) patch.name = name
  if (form.prompt !== task.prompt) patch.prompt = form.prompt
  const schedule = scheduleOf(form)
  if (!same(schedule, task.schedule)) patch.schedule = schedule
  // 时区给 null 的意思是“设备的”：编辑时没有这一档，任务已经有自己的时区了
  if (form.timezone !== null && form.timezone !== task.timezone) patch.timezone = form.timezone
  if (task.target.kind === 'newThread' && form.target === 'newThread') {
    const target: NonNullable<TaskPatch['target']> = {}
    if (form.cwd.trim() !== task.target.cwd) target.cwd = form.cwd.trim()
    if (form.workspaceId !== task.target.workspaceId) target.workspaceId = form.workspaceId
    if (!same(form.settings, task.target.settings)) target.settings = { ...form.settings }
    if (Object.keys(target).length > 0) patch.target = target
  }
  return Object.keys(patch).length > 0 ? patch : null
}
