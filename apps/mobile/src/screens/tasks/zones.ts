// 时区的选项：手机所在的、任务原来的、现在选着的排在前面，后面是一份常用的；都没有的点“其他时区”自己填。
// 认不认识用协议包的 isTaskTimeZone（和设备上校验用的同一个）。
import {
  isTaskTimeZone,
  localTaskTimeZone,
} from '../../../../../packages/protocol/src/task-schedule.mjs'

const COMMON = [
  'UTC',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Australia/Sydney',
  'Pacific/Auckland',
]

export function zoneChoices(local: string, original: string | null, current: string): string[] {
  const front = [local, original, current].filter((zone): zone is string => !!zone)
  return [...new Set([...front, ...COMMON])]
}

/** 认不认识这个时区。日程函数出了意外时不拦着，设备那边还会校验 */
export function zoneOk(name: string): boolean {
  if (!name) return false
  try {
    return isTaskTimeZone(name)
  } catch {
    return true
  }
}

/** 手机所在的时区 */
export function phoneZone(): string {
  try {
    return localTaskTimeZone()
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  }
}
