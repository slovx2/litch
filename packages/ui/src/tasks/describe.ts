// 定时任务的人话：日程怎么说、一个时间点怎么说、运行的状态和失败的原因怎么说。两种语言。
// 纯函数，不依赖 React 和页面：界面测试直接引，移动端也可以按相对路径引来用。
// 时间点按这台电脑的时区说（看的人在这里）；日程按任务自己的时区说，和这台电脑不一样时后面带上时区名。
import type {
  TaskErrorView,
  TaskRunApprovalView,
  TaskRunView,
  TaskSchedule,
  TaskView,
  TaskWeekday,
} from '@litch/core'
import type { MessageKey, Translator } from '../i18n/index.ts'

/** 星期的顺序，周一在前 */
export const WEEKDAYS: readonly TaskWeekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

const pad = (value: number): string => String(value).padStart(2, '0')

/** 这台电脑所在的时区。认不出来是 UTC */
export function viewerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

const MONTHS_EN = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** 一组日期的各部分怎么填进文案：中文用数字的月，英文用月份的缩写 */
const dateArgs = (year: number, month: number, day: number, time: string) => ({
  year,
  month,
  monthName: MONTHS_EN[month - 1] ?? String(month),
  day,
  time,
})

/**
 * 几天怎么说：连着的三天以上说成“周一到周五”，否则一个一个列出来。
 * short：每周的那种写法（中文“每周一、四”只写一个字）
 */
export function daysText(days: readonly TaskWeekday[], t: Translator, short = false): string {
  const sorted = WEEKDAYS.filter((day) => days.includes(day))
  const name = (day: TaskWeekday) =>
    t((short ? `tasks.day.${day}` : `tasks.dayName.${day}`) as MessageKey)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (first && last && sorted.length >= 3) {
    const from = WEEKDAYS.indexOf(first)
    const to = WEEKDAYS.indexOf(last)
    if (to - from + 1 === sorted.length) {
      return t('tasks.dayRange', {
        from: t(`tasks.dayName.${first}` as MessageKey),
        to: t(`tasks.dayName.${last}` as MessageKey),
      })
    }
  }
  return sorted.map(name).join(t('tasks.dayJoin'))
}

/** “YYYY-MM-DDTHH:MM”这种墙钟时间怎么说（不换时区，原样） */
export function wallText(at: string, t: Translator, now = Date.now()): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(at)
  if (!match) return at
  const [, year, month, day, hour, minute] = match
  const args = dateArgs(Number(year), Number(month), Number(day), `${hour}:${minute}`)
  return new Date(now).getFullYear() === args.year
    ? t('tasks.when.date', args)
    : t('tasks.when.year', args)
}

/** 日程的人话，不带时区 */
export function scheduleText(schedule: TaskSchedule, t: Translator, now = Date.now()): string {
  switch (schedule.type) {
    case 'once':
      return t('tasks.sched.once', { at: wallText(schedule.at, t, now) })
    case 'interval':
      return schedule.minutes % 60 === 0
        ? t('tasks.sched.hours', { n: schedule.minutes / 60 })
        : t('tasks.sched.minutes', { n: schedule.minutes })
    case 'hourly': {
      const minute = pad(schedule.minute)
      const what =
        schedule.intervalHours === 1
          ? t('tasks.sched.hourly', { minute })
          : t('tasks.sched.everyHours', { n: schedule.intervalHours, minute })
      return schedule.days && schedule.days.length > 0 && schedule.days.length < 7
        ? t('tasks.sched.onDays', { what, days: daysText(schedule.days, t) })
        : what
    }
    case 'daily':
      return t('tasks.sched.daily', { time: schedule.time })
    case 'weekdays':
      return t('tasks.sched.weekdays', { time: schedule.time })
    case 'weekly':
      return t('tasks.sched.weekly', {
        days: daysText(schedule.days, t, true),
        time: schedule.time,
      })
    case 'monthly':
      return t(schedule.day > 28 ? 'tasks.sched.monthlyLast' : 'tasks.sched.monthly', {
        day: schedule.day,
        time: schedule.time,
      })
  }
}

/** 日程的人话；任务的时区和这台电脑不一样时后面带上时区名 */
export function scheduleLine(
  task: Pick<TaskView, 'schedule' | 'timezone'>,
  t: Translator,
  here = viewerZone(),
  now = Date.now(),
): string {
  const what = scheduleText(task.schedule, t, now)
  return task.timezone === here ? what : t('tasks.sched.zone', { what, zone: task.timezone })
}

const startOfDay = (ms: number): number => {
  const date = new Date(ms)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** 一个时间点（毫秒）怎么说：今天、明天、昨天带时刻，别的写月和日，不是今年的带上年。按这台电脑的时区 */
export function whenText(ms: number, now: number, t: Translator): string {
  const date = new Date(ms)
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / 86_400_000)
  if (days === 0) return t('tasks.when.today', { time })
  if (days === 1) return t('tasks.when.tomorrow', { time })
  if (days === -1) return t('tasks.when.yesterday', { time })
  const args = dateArgs(date.getFullYear(), date.getMonth() + 1, date.getDate(), time)
  return date.getFullYear() === new Date(now).getFullYear()
    ? t('tasks.when.date', args)
    : t('tasks.when.year', args)
}

export const runStatusText = (status: TaskRunView['status'], t: Translator): string =>
  t(`tasks.run.${status}` as MessageKey)

export const triggerText = (trigger: TaskRunView['trigger'], t: Translator): string =>
  t(`tasks.trigger.${trigger}` as MessageKey)

/** 回合里一条要人答的请求：种类加一句话 */
export const askLine = (entry: TaskRunApprovalView, t: Translator): string => {
  const kind = t(`tasks.ask.kind.${entry.kind}` as MessageKey)
  return entry.title ? t('tasks.ask.line', { kind, title: entry.title }) : kind
}

/** 它现在怎样：等着（还剩几分钟）、处理了、自动拒绝了（等了多久、什么时候） */
export function askStateText(entry: TaskRunApprovalView, now: number, t: Translator): string {
  if (entry.state === 'waiting')
    return t('tasks.ask.waiting', {
      minutes: Math.max(1, Math.ceil((entry.declineAt - now) / 60_000)),
    })
  if (entry.state === 'autoDeclined')
    return t('tasks.ask.autoDeclined', {
      minutes: Math.max(1, Math.round((entry.declineAt - entry.requestedAt) / 60_000)),
      when: whenText(entry.settledAt ?? entry.declineAt, now, t),
    })
  return t('tasks.ask.resolved')
}

/** 这次运行里还在等人答的 */
export const waitingAsks = (run: TaskRunView | null | undefined): TaskRunApprovalView[] =>
  run?.approvals.filter((entry) => entry.state === 'waiting') ?? []

/** 失败的原因：种类说一句人话，后面跟设备的原话 */
export function errorText(error: TaskErrorView, t: Translator): string {
  const reason = t(`tasks.error.${error.code}` as MessageKey)
  return error.message ? t('tasks.error.line', { reason, message: error.message }) : reason
}

/** 运行在列表和通知里的样子：状态的种类（给样式和自检用） */
export function runTone(status: TaskRunView['status']): 'ok' | 'err' | 'run' | 'wait' | 'off' {
  switch (status) {
    case 'succeeded':
      return 'ok'
    case 'failed':
      return 'err'
    case 'running':
      return 'run'
    case 'queued':
      return 'wait'
    case 'canceled':
      return 'off'
  }
}
