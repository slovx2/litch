// 任务表单里的日程：界面上的几栏（ScheduleForm）和协议的 TaskSchedule 来回换，以及日程的人话描述。
// 纯逻辑，不碰 React，单测在 test/tasks.test.mjs。怎么算下一次不在这里：用协议包的 task-schedule.mts。
// 表单的几栏各日程共用：换了日程种类，填过的时刻、星期还留着，切回来不用重填。
import type {
  TaskSchedule,
  TaskScheduleType,
  TaskWeekday,
} from '../../../../../packages/protocol/src/device-tasks.mjs'
import type { Key, Translator } from '../../ui/i18n'

export const WEEKDAYS: TaskWeekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const WORKDAYS: TaskWeekday[] = ['MO', 'TU', 'WE', 'TH', 'FR']

/** 表单上能选的日程种类，按这个顺序列 */
export const SCHEDULE_TYPES: TaskScheduleType[] = [
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'hourly',
  'interval',
  'once',
]

/** 表单的几栏。敲进去的都留原文（字符串），交的时候再读成日程（readForm） */
export interface ScheduleForm {
  type: TaskScheduleType
  /** 时刻 HH:MM（daily、weekdays、weekly、monthly） */
  time: string
  /** weekly 的星期；hourly 只在这几天时也用它（hourlyAllDays 为假时） */
  days: TaskWeekday[]
  /** monthly：每月第几天，1–31 */
  monthDay: string
  /** hourly：每隔几小时、第几分 */
  intervalHours: string
  minute: string
  /** hourly：每天都跑（不限星期） */
  hourlyAllDays: boolean
  /** interval：每隔几分钟 */
  minutes: string
  /** once：日期 YYYY-MM-DD 和时刻 */
  date: string
  onceTime: string
}

const pad = (value: number) => String(value).padStart(2, '0')

/** 新表单的默认：每天 09:00；一次性的日期是明天（按给的“今天”） */
export function defaultForm(today: string): ScheduleForm {
  return {
    type: 'daily',
    time: '09:00',
    days: ['MO'],
    monthDay: '1',
    intervalHours: '1',
    minute: '0',
    hourlyAllDays: true,
    minutes: '30',
    date: addDays(today, 1),
    onceTime: '09:00',
  }
}

/** YYYY-MM-DD 往后几天（按公历算，不涉及时区） */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const at = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days))
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
}

/** 已有的日程填回表单（编辑时），没用到的几栏取默认 */
export function formOf(schedule: TaskSchedule, today: string): ScheduleForm {
  const base = defaultForm(today)
  switch (schedule.type) {
    case 'once': {
      const [date, time] = schedule.at.split('T')
      return { ...base, type: 'once', date: date ?? base.date, onceTime: time ?? base.onceTime }
    }
    case 'interval':
      return { ...base, type: 'interval', minutes: String(schedule.minutes) }
    case 'hourly':
      return {
        ...base,
        type: 'hourly',
        intervalHours: String(schedule.intervalHours),
        minute: String(schedule.minute),
        hourlyAllDays: schedule.days === null,
        days: schedule.days ?? base.days,
      }
    case 'daily':
    case 'weekdays':
      return { ...base, type: schedule.type, time: schedule.time }
    case 'weekly':
      return { ...base, type: 'weekly', days: schedule.days, time: schedule.time }
    case 'monthly':
      return { ...base, type: 'monthly', monthDay: String(schedule.day), time: schedule.time }
  }
}

/** 星期按周一到周日排好、去掉重复 */
export function sortDays(days: TaskWeekday[]): TaskWeekday[] {
  return WEEKDAYS.filter((day) => days.includes(day))
}

/** 表单哪一栏、为什么读不成日程。message 是文案键 */
export interface FormProblem {
  field: keyof ScheduleForm
  message: Key
  args?: Record<string, number>
}

export type ReadResult = { ok: true; schedule: TaskSchedule } | ({ ok: false } & FormProblem)

function wholeIn(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null
  const value = Number(text.trim())
  return value >= min && value <= max ? value : null
}

/**
 * 表单读成日程。这里只挡写法不对的（时刻、日期、整数的范围、星期没选）；
 * 读出来的日程合不合规矩（最小间隔、一次性的时间过没过）再交给协议包的 validateTaskSchedule。
 * minMinutes：interval 最少几分钟（MIN_TASK_INTERVAL_MINUTES）
 */
export function readForm(form: ScheduleForm, minMinutes: number): ReadResult {
  const bad = (field: keyof ScheduleForm, message: Key, args?: Record<string, number>) =>
    ({ ok: false, field, message, ...(args ? { args } : {}) }) as const
  const number = (
    field: 'monthDay' | 'intervalHours' | 'minute' | 'minutes',
    min: number,
    max: number,
  ) => {
    const value = wholeIn(form[field], min, max)
    return value === null ? bad(field, 'tasks.bad.number', { min, max }) : value
  }
  const clock = (field: 'time' | 'onceTime') =>
    tidyTime(form[field]) ?? bad(field, 'tasks.bad.time')
  switch (form.type) {
    case 'once': {
      const date = tidyDate(form.date)
      if (!date) return bad('date', 'tasks.bad.date')
      const time = clock('onceTime')
      if (typeof time !== 'string') return time
      return { ok: true, schedule: { type: 'once', at: `${date}T${time}` } }
    }
    case 'interval': {
      const minutes = number('minutes', minMinutes, 7 * 24 * 60)
      if (typeof minutes !== 'number') return minutes
      return { ok: true, schedule: { type: 'interval', minutes } }
    }
    case 'hourly': {
      const intervalHours = number('intervalHours', 1, 23)
      if (typeof intervalHours !== 'number') return intervalHours
      const minute = number('minute', 0, 59)
      if (typeof minute !== 'number') return minute
      if (!form.hourlyAllDays && form.days.length === 0) return bad('days', 'tasks.bad.days')
      const days = form.hourlyAllDays ? null : sortDays(form.days)
      return { ok: true, schedule: { type: 'hourly', intervalHours, minute, days } }
    }
    case 'daily':
    case 'weekdays': {
      const time = clock('time')
      if (typeof time !== 'string') return time
      return { ok: true, schedule: { type: form.type, time } }
    }
    case 'weekly': {
      if (form.days.length === 0) return bad('days', 'tasks.bad.days')
      const time = clock('time')
      if (typeof time !== 'string') return time
      return { ok: true, schedule: { type: 'weekly', days: sortDays(form.days), time } }
    }
    case 'monthly': {
      const day = number('monthDay', 1, 31)
      if (typeof day !== 'number') return day
      const time = clock('time')
      if (typeof time !== 'string') return time
      return { ok: true, schedule: { type: 'monthly', day, time } }
    }
  }
}

/** 用户敲的时刻整理成 HH:MM：认 9、9:5、0930、09:30 这几种写法；认不出是 null */
export function tidyTime(text: string): string | null {
  const trimmed = text.trim()
  const match = /^(\d{1,2})(?::?(\d{2}))?$/.exec(trimmed) ?? /^(\d{1,2}):(\d)$/.exec(trimmed)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2] ?? 0)
  if (hour > 23 || minute > 59) return null
  return `${pad(hour)}:${pad(minute)}`
}

/** 用户敲的日期整理成 YYYY-MM-DD；不是真实存在的日子是 null */
export function tidyDate(text: string): string | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text.trim())
  if (!match) return null
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const at = new Date(Date.UTC(y, m - 1, d))
  if (at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null
  return `${y}-${pad(m)}-${pad(d)}`
}

const DAY_KEY: Record<TaskWeekday, Key> = {
  MO: 'tasks.day.MO',
  TU: 'tasks.day.TU',
  WE: 'tasks.day.WE',
  TH: 'tasks.day.TH',
  FR: 'tasks.day.FR',
  SA: 'tasks.day.SA',
  SU: 'tasks.day.SU',
}

export const dayName = (day: TaskWeekday, t: Translator): string => t(DAY_KEY[day])

/** 一串星期说成人话：周一到周五说“工作日”，七天都有说“每天”，其余逐个列出 */
function daysText(days: TaskWeekday[], t: Translator): string {
  const sorted = sortDays(days)
  if (sorted.length === 7) return t('tasks.sched.everyDay')
  if (sorted.length === 5 && WORKDAYS.every((day) => sorted.includes(day)))
    return t('tasks.sched.workdays')
  return sorted.map((day) => dayName(day, t)).join(t('tasks.sep'))
}

/**
 * 日程的人话描述，比如“每天 09:00”“每周一、三 09:00”“每 30 分钟”。
 * 任务的时区和手机的不同时在后面带上时区名（时刻都是按任务的时区说的）。
 */
export function describeSchedule(
  schedule: TaskSchedule,
  timezone: string | null,
  localZone: string,
  t: Translator,
): string {
  const text = describeBare(schedule, t)
  return timezone && timezone !== localZone ? t('tasks.sched.zone', { text, zone: timezone }) : text
}

function describeBare(schedule: TaskSchedule, t: Translator): string {
  switch (schedule.type) {
    case 'once':
      return t('tasks.sched.once', { at: schedule.at.replace('T', ' ') })
    case 'interval':
      return schedule.minutes % 60 === 0
        ? t('tasks.sched.intervalHours', { count: schedule.minutes / 60 })
        : t('tasks.sched.interval', { count: schedule.minutes })
    case 'hourly': {
      const every =
        schedule.intervalHours === 1
          ? t('tasks.sched.hourly', { minute: pad(schedule.minute) })
          : t('tasks.sched.hourlyN', {
              count: schedule.intervalHours,
              minute: pad(schedule.minute),
            })
      return schedule.days === null || sortDays(schedule.days).length === 7
        ? every
        : t('tasks.sched.onDays', { text: every, days: daysText(schedule.days, t) })
    }
    case 'daily':
      return t('tasks.sched.daily', { time: schedule.time })
    case 'weekdays':
      return t('tasks.sched.weekdays', { time: schedule.time })
    case 'weekly': {
      const days = sortDays(schedule.days)
      if (days.length === 7) return t('tasks.sched.daily', { time: schedule.time })
      if (days.length === 5 && WORKDAYS.every((day) => days.includes(day)))
        return t('tasks.sched.weekdays', { time: schedule.time })
      return t('tasks.sched.weekly', { days: daysText(days, t), time: schedule.time })
    }
    case 'monthly':
      return schedule.day > 28
        ? t('tasks.sched.monthlyLate', { day: schedule.day, time: schedule.time })
        : t('tasks.sched.monthly', { day: schedule.day, time: schedule.time })
  }
}

const TYPE_KEY: Record<TaskScheduleType, Key> = {
  once: 'tasks.type.once',
  interval: 'tasks.type.interval',
  hourly: 'tasks.type.hourly',
  daily: 'tasks.type.daily',
  weekdays: 'tasks.type.weekdays',
  weekly: 'tasks.type.weekly',
  monthly: 'tasks.type.monthly',
}

export const typeName = (type: TaskScheduleType, t: Translator): string => t(TYPE_KEY[type])
