// 给人看的时间和“没做成的原因”。和桌面端 packages/ui/src/app/format.ts、errors.ts 的同名函数一个说法；
// Metro 只看得见桌面界面的文案目录（metro.config.js 的 watchFolders），所以这几行在这边另写一份。
import type { Bilingual, Text } from '@litch/core'
import type { Translator } from '../../ui/i18n'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 多久以前：现在、12分、3时、5天，更早的写月和日 */
export function ago(timestamp: number, now: number, t: Translator): string {
  const diff = Math.max(0, now - timestamp)
  if (diff < MINUTE) return t('time.now')
  if (diff < HOUR) return t('time.minutes', { n: Math.floor(diff / MINUTE) })
  if (diff < DAY) return t('time.hours', { n: Math.floor(diff / HOUR) })
  if (diff < 7 * DAY) return t('time.days', { n: Math.floor(diff / DAY) })
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/** 一件事没做成的原因：核心说得出是哪一句的按当前语言说，设备给了两种语言的挑一种，别的是原话 */
export function reasonOf(error: unknown, t: Translator): string {
  const { text, said } = (error ?? {}) as { text?: Text; said?: Bilingual }
  if (text) return t.text(text)
  if (said) return t.said(said)
  return error instanceof Error ? error.message : String(error)
}
