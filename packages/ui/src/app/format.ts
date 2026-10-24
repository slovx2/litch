// 给人看的时间和时长。侧栏的行很窄，所以用最短的写法。
import type { TurnRetryView } from '@litch/core'
import type { Translator } from '../i18n/index.ts'

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

/** 还在走的时长，整秒：7 秒、2 分 08 秒。给“已经跑了多久”用，不带小数，免得末位一直跳 */
export function elapsed(ms: number, t: Translator): string {
  const whole = Math.floor(ms / 1000)
  if (whole < 60) return t('duration.seconds', { n: whole })
  return t('duration.minutes', {
    m: Math.floor(whole / 60),
    s: String(whole % 60).padStart(2, '0'),
  })
}

/** 时长：180 毫秒、3.4 秒、2 分 08 秒 */
export function duration(ms: number, t: Translator): string {
  if (ms < 1000) return t('duration.ms', { n: Math.round(ms) })
  if (ms < MINUTE) return t('duration.seconds', { n: (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) })
  const minutes = Math.floor(ms / MINUTE)
  const seconds = Math.floor((ms % MINUTE) / 1000)
  return t('duration.minutes', { m: minutes, s: String(seconds).padStart(2, '0') })
}

const RETRY_REASONS = {
  connection: 'turn.retry.connection',
  noResponse: 'turn.retry.noResponse',
  overloaded: 'turn.retry.overloaded',
  rateLimit: 'turn.retry.rateLimit',
  server: 'turn.retry.server',
  other: 'turn.retry.other',
} as const

/** 模型请求在重试时状态行上的那一段：重试中 2/10 · 连接中断。不知道最多几次时写第几次 */
export function retryText(retry: TurnRetryView, t: Translator): string {
  const progress = retry.maxRetries
    ? t('turn.retry', { n: retry.attempt, max: retry.maxRetries })
    : t('turn.retryBare', { n: retry.attempt })
  const reason = t(RETRY_REASONS[retry.reason] ?? RETRY_REASONS.other)
  const cause =
    retry.httpStatus !== null && (retry.reason === 'server' || retry.reason === 'other')
      ? t('turn.retry.status', { reason, status: retry.httpStatus })
      : reason
  return `${progress} · ${cause}`
}
