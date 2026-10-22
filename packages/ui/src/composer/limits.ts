// 账号额度怎么写成字（AccountLimits.tsx 用）：窗口叫什么、多久之后重置。不碰界面，测试直接引用
import type { AccountLimitWindow } from '@litch/core'
import type { Translator } from '../i18n/index.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 窗口叫什么：5 小时、每周；对面没说多长就只写“额度” */
export function windowLabel(window: AccountLimitWindow, t: Translator): string {
  const mins = window.windowMins
  if (!mins) return t('limits.window.other')
  if (mins === 7 * 1440) return t('limits.window.week')
  if (mins % 1440 === 0) return t('limits.window.days', { n: mins / 1440 })
  if (mins % 60 === 0) return t('limits.window.hours', { n: mins / 60 })
  return t('limits.window.other')
}

/** 多久之后重置：2 小时 13 分后重置、4 天 3 小时后重置。没说什么时候是 null */
export function resetsIn(resetsAt: number | null, now: number, t: Translator): string | null {
  if (resetsAt === null) return null
  const left = resetsAt - now
  if (left < MINUTE) return t('limits.resetSoon')
  const when =
    left < HOUR
      ? t('limits.in.minutes', { m: Math.floor(left / MINUTE) })
      : left < DAY
        ? t('limits.in.hours', {
            h: Math.floor(left / HOUR),
            m: Math.floor((left % HOUR) / MINUTE),
          })
        : t('limits.in.days', { d: Math.floor(left / DAY), h: Math.floor((left % DAY) / HOUR) })
  return t('limits.resetsIn', { when })
}
