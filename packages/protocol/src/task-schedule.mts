// 定时任务的日程怎么算：校验、下一次在什么时候、一段时间里错过了几次。
// 设备进程按它排日程，客户端按它在表单里预览“下一次”。只用标准库（Intl 算时区），不引别的包：
// 设备进程没有自己的 node_modules，移动端的 Hermes 也要能跑。
// 时间一律是 Unix 秒。日程的含义见 device-tasks.mts 的 TaskSchedule。
//
// 算法：墙钟时间记成“墙钟秒”（把墙钟当成 UTC 算出的秒数），时区偏移 = 墙钟秒 − Unix 秒，
// 用 Intl.DateTimeFormat#formatToParts 求。interval 直接按秒算；once 只换算一次；
// 其余几种（日历日程）按任务时区里的日期一天一天往后排出候选时刻，换算成 Unix 秒。
import type { TaskSchedule, TaskWeekday } from './device-tasks.mjs'

/** 相邻两次运行至少隔这么多分钟。interval 的 minutes 不能比它小；别的日程算出来更密的也按它拉开 */
export const MIN_TASK_INTERVAL_MINUTES = 5

/** interval 的 minutes 最多这么大（366 天），免得乘出来的秒数大到失去精度 */
const MAX_INTERVAL_MINUTES = 366 * 24 * 60

/** 校验不过时说哪个字段、为什么 */
export interface TaskScheduleProblem {
  /** schedule、schedule.time、schedule.days、timezone 这样的路径 */
  field: string
  /** 英文的一句话，给人和模型看 */
  message: string
}

const DAY = 86_400
const MIN_GAP = MIN_TASK_INTERVAL_MINUTES * 60
/** 日历日程往后找这么多天还没有一次就放弃（合法的日程最多隔 62 天，这是兜底） */
const MAX_SCAN_DAYS = 800

/** getUTCDay 的顺序：0 是星期日 */
const WEEKDAYS: readonly TaskWeekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

// ---------- 时区 ----------

/** 每个时区一个格式化器，建一个要几十微秒，反复用 */
const formatters = new Map<string, Intl.DateTimeFormat>()
const zoneValidity = new Map<string, boolean>()

/** IANA 名的样子：Asia/Shanghai、UTC、Etc/GMT+8、America/Argentina/Buenos_Aires。挡掉 +08:00 这类偏移写法 */
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/** 是不是这台机器认识的 IANA 时区名 */
export function isTaskTimeZone(name: string): boolean {
  if (typeof name !== 'string' || !ZONE_NAME.test(name)) return false
  let valid = zoneValidity.get(name)
  if (valid === undefined) {
    try {
      formatterFor(name)
      valid = true
    } catch {
      valid = false
    }
    zoneValidity.set(name, valid)
  }
  return valid
}

/** 这台机器所在的时区（IANA 名）；认不出来是 UTC */
export function localTaskTimeZone(): string {
  let zone: unknown
  try {
    zone = new Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
  return typeof zone === 'string' && isTaskTimeZone(zone) ? zone : 'UTC'
}

/** Unix 秒 instant 在 timeZone 里的偏移（秒，东正西负） */
function offsetAt(timeZone: string, instant: number): number {
  const seconds = Math.floor(instant)
  const fields = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 }
  for (const part of formatterFor(timeZone).formatToParts(seconds * 1000)) {
    if (part.type in fields) fields[part.type as keyof typeof fields] = Number(part.value)
  }
  // 有的引擎在 h23 下午夜仍写 24（同一天的 0 点）
  if (fields.hour === 24) fields.hour = 0
  const wall =
    Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second) /
    1000
  return wall - seconds
}

/** Unix 秒 → 墙钟秒 */
function wallOf(timeZone: string, instant: number): number {
  return Math.floor(instant) + offsetAt(timeZone, instant)
}

/**
 * 墙钟秒 → Unix 秒。重复的时刻（夏令时结束）取第一次；跳过的时刻（夏令时开始）按切换前的偏移算，
 * 也就是往后顺延跳过的那么长，落在切换后的墙钟上（纽约 02:30 → 03:30，豪勋爵岛 02:15 → 02:45）。
 */
function instantOf(timeZone: string, wall: number): number {
  // 前后一天的偏移：两次切换隔不到两天的时区这里会认错（推测现行时区里没有）
  const before = offsetAt(timeZone, wall - DAY)
  const after = offsetAt(timeZone, wall + DAY)
  if (before === after) return wall - before
  let first: number | null = null
  for (const offset of [before, after]) {
    const instant = wall - offset
    if (offsetAt(timeZone, instant) === offset && (first === null || instant < first))
      first = instant
  }
  return first ?? wall - before
}

// ---------- 墙钟的小工具 ----------

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** HH:MM → 当天第几分钟（已校验过） */
function minuteOfDay(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
}

/** YYYY-MM-DDTHH:MM → 墙钟秒（已校验过） */
function wallOfLocal(at: string): number {
  const [date = '', time = ''] = at.split('T')
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number)
  return Date.UTC(year, month - 1, day) / 1000 + minuteOfDay(time) * 60
}

// ---------- 校验 ----------

const TIME_OF_DAY = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T((?:[01]\d|2[0-3]):[0-5]\d)$/

/** 每种日程除 type 外有哪些字段 */
const SCHEDULE_FIELDS: Record<TaskSchedule['type'], readonly string[]> = {
  once: ['at'],
  interval: ['minutes'],
  hourly: ['intervalHours', 'minute', 'days'],
  daily: ['time'],
  weekdays: ['time'],
  weekly: ['days', 'time'],
  monthly: ['day', 'time'],
}

function problem(field: string, message: string): TaskScheduleProblem {
  return { field: `schedule.${field}`, message }
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function checkTime(value: unknown): TaskScheduleProblem | null {
  return typeof value === 'string' && TIME_OF_DAY.test(value)
    ? null
    : problem('time', 'time must be a 24-hour time "HH:MM", such as "09:30".')
}

function checkDays(value: unknown): TaskScheduleProblem | null {
  if (!Array.isArray(value) || value.length === 0)
    return problem('days', 'days must be a non-empty array of weekdays such as ["MO", "WE"].')
  for (const day of value)
    if (!WEEKDAYS.includes(day as TaskWeekday))
      return problem('days', `days may only contain ${WEEKDAYS.slice(1).join(', ')}, SU.`)
  if (new Set(value).size !== value.length)
    return problem('days', 'days must not list the same weekday twice.')
  return null
}

function checkAt(value: unknown): TaskScheduleProblem | null {
  const match = typeof value === 'string' ? LOCAL_DATE_TIME.exec(value) : null
  if (!match)
    return problem(
      'at',
      'at must be a local date and time "YYYY-MM-DDTHH:MM", such as "2026-10-20T09:30".',
    )
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month))
    return problem('at', `at is not a real date: ${match[1]}-${match[2]}-${match[3]}.`)
  return null
}

/** 日程和时区合不合法。合法是 null。schedule 可以是任意值（来自线上） */
export function validateTaskSchedule(
  schedule: unknown,
  timezone: unknown,
): TaskScheduleProblem | null {
  if (typeof schedule !== 'object' || schedule === null || Array.isArray(schedule))
    return { field: 'schedule', message: 'schedule must be an object with a "type" field.' }
  const record = schedule as Record<string, unknown>
  const type = record.type
  if (typeof type !== 'string' || !Object.hasOwn(SCHEDULE_FIELDS, type))
    return problem('type', `type must be one of ${Object.keys(SCHEDULE_FIELDS).join(', ')}.`)
  const allowed = SCHEDULE_FIELDS[type as TaskSchedule['type']]
  for (const key of Object.keys(record))
    if (key !== 'type' && !allowed.includes(key))
      return problem(key, `${key} is not a field of ${type} schedules.`)
  for (const key of allowed)
    if (!Object.hasOwn(record, key)) return problem(key, `${type} schedules need ${key}.`)

  const found = checkFields(type as TaskSchedule['type'], record)
  if (found) return found
  if (typeof timezone !== 'string' || !isTaskTimeZone(timezone))
    return {
      field: 'timezone',
      message:
        'timezone must be an IANA time zone name known to this device, such as "Asia/Shanghai".',
    }
  return null
}

function checkFields(
  type: TaskSchedule['type'],
  record: Record<string, unknown>,
): TaskScheduleProblem | null {
  switch (type) {
    case 'once':
      return checkAt(record.at)
    case 'interval':
      return isInteger(record.minutes, MIN_TASK_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES)
        ? null
        : problem(
            'minutes',
            `minutes must be a whole number from ${MIN_TASK_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}.`,
          )
    case 'hourly':
      if (!isInteger(record.intervalHours, 1, 23))
        return problem('intervalHours', 'intervalHours must be a whole number from 1 to 23.')
      if (!isInteger(record.minute, 0, 59))
        return problem('minute', 'minute must be a whole number from 0 to 59.')
      return record.days === null ? null : checkDays(record.days)
    case 'daily':
    case 'weekdays':
      return checkTime(record.time)
    case 'weekly':
      return checkDays(record.days) ?? checkTime(record.time)
    case 'monthly':
      return isInteger(record.day, 1, 31)
        ? checkTime(record.time)
        : problem('day', 'day must be a whole number from 1 to 31.')
  }
}

// ---------- 下一次、错过了几次 ----------

type CalendarSchedule = Exclude<TaskSchedule, { type: 'once' } | { type: 'interval' }>

/** 某一天（任务时区里的日期，1970-01-01 是第 0 天）要跑的时刻，当天第几分钟，从小到大 */
function minutesOn(schedule: CalendarSchedule, day: number): number[] {
  const date = new Date(day * DAY * 1000)
  const weekday = WEEKDAYS[date.getUTCDay()] as TaskWeekday
  switch (schedule.type) {
    case 'hourly': {
      if (schedule.days !== null && !schedule.days.includes(weekday)) return []
      const minutes: number[] = []
      const step = Math.max(1, schedule.intervalHours)
      for (let hour = 0; hour < 24; hour += step) minutes.push(hour * 60 + schedule.minute)
      return minutes
    }
    case 'daily':
      return [minuteOfDay(schedule.time)]
    case 'weekdays':
      return weekday === 'SA' || weekday === 'SU' ? [] : [minuteOfDay(schedule.time)]
    case 'weekly':
      return schedule.days.includes(weekday) ? [minuteOfDay(schedule.time)] : []
    case 'monthly': {
      const last = daysInMonth(date.getUTCFullYear(), date.getUTCMonth() + 1)
      return date.getUTCDate() === Math.min(schedule.day, last) ? [minuteOfDay(schedule.time)] : []
    }
  }
}

/**
 * 日历日程的运行时刻，按先后，从 start 所在那天的前一天排起，不设终点（调用方自己停）。
 * 离前一个候选不到 MIN_TASK_INTERVAL_MINUTES 分钟的不算（夏令时开始时顺延的时刻会和下一个撞在一起，
 * 只留一个）。只跟前一个候选比，所以从哪天排起都得到同样的结果。
 */
function* calendarRuns(
  schedule: CalendarSchedule,
  timeZone: string,
  start: number,
): Generator<number, void, undefined> {
  let previous: number | null = null
  let idle = 0
  for (let day = Math.floor(wallOf(timeZone, start) / DAY) - 1; idle < MAX_SCAN_DAYS; day++) {
    const minutes = minutesOn(schedule, day)
    idle = minutes.length === 0 ? idle + 1 : 0
    // 同一天里顺延的时刻可能排到后面的时刻之后，先排个序
    const instants = minutes.map((minute) => instantOf(timeZone, day * DAY + minute * 60))
    instants.sort((a, b) => a - b)
    for (const instant of instants) {
      if (previous === null || instant - previous >= MIN_GAP) yield instant
      previous = instant
    }
  }
}

function intervalStep(minutes: number): number {
  return Math.max(minutes, MIN_TASK_INTERVAL_MINUTES) * 60
}

/**
 * 严格晚于 after 的下一次运行时间；以后不会再有（once 已经过了）是 null。
 * anchor：日程从什么时候起算（任务建好、或者这条日程改好的时间）。interval 从它起每隔 minutes 一次；
 * once 早于 anchor 的算已经过了；别的日程只用它保证不早于它。
 * 调用方保证 schedule、timezone 已经校验过。
 */
export function nextTaskRun(
  schedule: TaskSchedule,
  timezone: string,
  after: number,
  anchor: number,
): number | null {
  switch (schedule.type) {
    case 'interval': {
      // anchor 本身不算，第一次是 anchor + minutes
      const step = intervalStep(schedule.minutes)
      return anchor + Math.max(1, Math.floor((after - anchor) / step) + 1) * step
    }
    case 'once': {
      const at = instantOf(timezone, wallOfLocal(schedule.at))
      return at >= anchor && at > after ? at : null
    }
    default:
      for (const run of calendarRuns(schedule, timezone, Math.max(after, anchor)))
        if (run > after && run >= anchor) return run
      return null
  }
}

/**
 * (from, to] 之间有几个运行时间点，最多数到 limit 就停（错过很久时不必数完）。
 * 设备进程用它算“这次合并了几次”。anchor 同 nextTaskRun。
 */
export function countTaskRuns(
  schedule: TaskSchedule,
  timezone: string,
  from: number,
  to: number,
  anchor: number,
  limit = 1000,
): number {
  if (!(to > from) || !(limit > 0)) return 0
  switch (schedule.type) {
    case 'interval': {
      const step = intervalStep(schedule.minutes)
      const first = Math.max(1, Math.floor((from - anchor) / step) + 1)
      const last = Math.floor((to - anchor) / step)
      return Math.min(Math.max(0, last - first + 1), limit)
    }
    case 'once': {
      const at = instantOf(timezone, wallOfLocal(schedule.at))
      return at >= anchor && at > from && at <= to ? 1 : 0
    }
    default: {
      let count = 0
      for (const run of calendarRuns(schedule, timezone, Math.max(from, anchor))) {
        if (run > to) break
        if (run > from && run >= anchor && ++count >= limit) break
      }
      return count
    }
  }
}
