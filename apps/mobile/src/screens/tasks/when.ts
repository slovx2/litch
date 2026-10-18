// 任务和运行记录上的时间怎么说：下一次、最近一次、运行开始结束。都按手机所在的时区说
// （日程本身按任务的时区，描述里会带上时区名，见 schedule.ts）。
// 时间一律是 Unix 秒（协议的写法），“现在”是毫秒（Date.now()，和别处的钟一样）。
import type { Translator } from '../../ui/i18n'

interface Wall {
  date: string
  time: string
}

const formatters = new Map<string, Intl.DateTimeFormat>()

/** 某个时区里的墙钟日期和时刻。zone 不给是手机所在的时区 */
export function wallOf(seconds: number, zone?: string): Wall {
  const key = zone ?? ''
  let formatter = formatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      ...(zone ? { timeZone: zone } : {}),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    formatters.set(key, formatter)
  }
  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(seconds * 1000)) parts[part.type] = part.value
  // 有的实现把午夜写成 24
  const hour = parts.hour === '24' ? '00' : parts.hour
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}` }
}

/** 今天的日期 YYYY-MM-DD（手机所在的时区，或者给的时区） */
export function todayOf(nowMs: number, zone?: string): string {
  return wallOf(Math.floor(nowMs / 1000), zone).date
}

/** “今天 09:00”“明天 09:00”“昨天 23:10”，再远的写日期；不是今年的带上年份 */
export function whenText(seconds: number, nowMs: number, t: Translator, zone?: string): string {
  const at = wallOf(seconds, zone)
  const today = wallOf(Math.floor(nowMs / 1000), zone).date
  const day = dayDiff(today, at.date)
  if (day === 0) return t('tasks.when.today', { time: at.time })
  if (day === 1) return t('tasks.when.tomorrow', { time: at.time })
  if (day === -1) return t('tasks.when.yesterday', { time: at.time })
  const date = at.date.slice(0, 4) === today.slice(0, 4) ? at.date.slice(5) : at.date
  return t('tasks.when.date', { date, time: at.time })
}

function dayDiff(from: string, to: string): number {
  const ms = (date: string) => {
    const [y, m, d] = date.split('-').map(Number)
    return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)
  }
  return Math.round((ms(to) - ms(from)) / 86_400_000)
}
