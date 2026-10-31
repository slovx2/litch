// 给人看的时间和时长。侧栏的行很窄，所以用最短的写法。
import type { TurnRetryView, TurnView } from '@litch/core'
import type { Translator } from '../i18n/index.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// 长会话的每条消息都有时间，复用有限几种格式，避免逐条初始化 Intl。
const formats = new Map<string, Intl.DateTimeFormat>()
function dateFormat(lang: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${lang}:${JSON.stringify(options)}`
  let format = formats.get(key)
  if (!format) {
    format = new Intl.DateTimeFormat(lang, options)
    formats.set(key, format)
  }
  return format
}

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

/** 两个时刻差几个自然日（按本地时间，0 是同一天） */
function daysApart(earlier: number, later: number): number {
  const a = new Date(earlier)
  const b = new Date(later)
  const start = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  return Math.round((start(b) - start(a)) / DAY)
}

/**
 * 消息上的时刻（照 Codex 桌面端）：当天只写时刻；六天内写星期加时刻；更早写月日加时刻，不是今年的再带上年
 * （Codex 跨年也不写年）。在未来的（两边时钟对不齐）按当天算
 */
export function stamp(timestamp: number, now: number, lang: string): string {
  const time = { hour: 'numeric', minute: '2-digit' } as const
  const days = Math.max(0, daysApart(timestamp, now))
  // 星期和时刻分开排再用空格接上：中文合在一起排是“星期一14:32”，中间没有空格
  if (days > 0 && days < 7) {
    const weekday = dateFormat(lang, { weekday: 'long' }).format(timestamp)
    return `${weekday} ${dateFormat(lang, time).format(timestamp)}`
  }
  const options: Intl.DateTimeFormatOptions =
    days === 0
      ? time
      : new Date(timestamp).getFullYear() === new Date(now).getFullYear()
        ? { ...time, month: 'short', day: 'numeric' }
        : { ...time, year: 'numeric', month: 'short', day: 'numeric' }
  return dateFormat(lang, options).format(timestamp)
}

/** 悬停时看的完整时刻：年月日加时分 */
export function stampFull(timestamp: number, lang: string): string {
  return dateFormat(lang, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp)
}

/** 回合结束的时刻：开始时刻加用时。还在跑、或者两样有一样对面没给，是 null */
export function turnEnded(
  turn: Pick<TurnView, 'status' | 'startedAt' | 'durationMs'>,
): number | null {
  if (turn.status === 'running' || turn.startedAt === null || turn.durationMs === null) return null
  return turn.startedAt + turn.durationMs
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
  if (retry.message) return retry.message
  if (retry.attempt === null) return t('turn.retryUnknown')
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
