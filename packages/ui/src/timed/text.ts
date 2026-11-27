// 限时授权的说法（不依赖界面框架）：类别的名字、到期时刻。桌面与手机共用。
import type { TimedApprovalCategory } from '@litch/core'
import type { MessageKey, Translator } from '../i18n/index.ts'
import { formattingLocale } from '../i18n/locale.ts'

const CATEGORY_TEXT: Record<Exclude<TimedApprovalCategory, 'mcp'>, MessageKey> = {
  command: 'timed.category.command',
  fileChange: 'timed.category.fileChange',
  permissions: 'timed.category.permissions',
  machine: 'timed.category.machine',
  browser: 'timed.category.browser',
  chrome: 'timed.category.chrome',
}

/** 一类授权怎么称呼；MCP 带上服务名。认不出的类别（设备比客户端新）返回 null，界面不画 */
export function timedWhat(
  t: Translator,
  target: { category: string; scope: string },
): string | null {
  if (target.category === 'mcp')
    return target.scope ? t('timed.category.mcp', { server: target.scope }) : null
  const key = CATEGORY_TEXT[target.category as keyof typeof CATEGORY_TEXT]
  return key ? t(key) : null
}

const formats = new Map<string, Intl.DateTimeFormat>()
const format = (lang: string, sameDay: boolean) => {
  const key = `${lang}:${sameDay}`
  let found = formats.get(key)
  if (!found) {
    found = new Intl.DateTimeFormat(formattingLocale(lang), {
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
