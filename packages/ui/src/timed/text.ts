// 限时授权的说法（不依赖界面框架）：类别的文案键、到期时刻。桌面与手机共用。
import type { TimedApprovalCategory } from '@litch/core'
import type { MessageKey } from '../i18n/index.ts'

export const CATEGORY_TEXT: Record<TimedApprovalCategory, MessageKey> = {
  command: 'timed.category.command',
  fileChange: 'timed.category.fileChange',
  permissions: 'timed.category.permissions',
  machine: 'timed.category.machine',
  browser: 'timed.category.browser',
  chrome: 'timed.category.chrome',
}

const formats = new Map<string, Intl.DateTimeFormat>()
const format = (lang: string, sameDay: boolean) => {
  const key = `${lang}:${sameDay}`
  let found = formats.get(key)
  if (!found) {
    found = new Intl.DateTimeFormat(lang, {
      hour: 'numeric',
      minute: '2-digit',
      ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
    })
    formats.set(key, found)
  }
  return found
}

/** 到期时刻：当天只写时分，跨天加月日 */
export function untilText(expiresAt: number, now: number, lang: string): string {
  const sameDay = new Date(expiresAt).toDateString() === new Date(now).toDateString()
  return format(lang, sameDay).format(expiresAt)
}
