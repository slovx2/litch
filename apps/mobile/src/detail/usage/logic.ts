// 用量页（UsageSheet.tsx）和会话菜单里“压缩上下文”的判断，不碰界面，测试直接引用。
// 规矩照桌面端：上下文占比、额度的说法（packages/ui/src/composer/limits.ts）、压缩入口什么时候出、什么时候压不了
// （packages/ui/src/composer/Composer.tsx 的 SessionComposer、ContextMeter.tsx）。
import type { AccountLimitRow, ContextUsage, SessionView } from '@litch/core'
import {
  resetsIn,
  shortTokens,
  windowLabel,
} from '../../../../../packages/ui/src/composer/limits.ts'
import type { Translator } from '../../ui/i18n'

/** 上下文用了百分之几；对面没报、或者没报窗口多大是 null */
export function contextPercent(usage: ContextUsage | null | undefined): number | null {
  if (!usage?.windowTokens || usage.windowTokens <= 0) return null
  return Math.min(100, Math.round((usage.usedTokens / usage.windowTokens) * 100))
}

/** 用量页里的一行：名字、百分比、补充的一句（词元数、多久后重置） */
export interface UsageLine {
  id: string
  label: string
  percent: number | null
  detail: string | null
}

export function contextLine(usage: ContextUsage | null | undefined, t: Translator): UsageLine {
  const percent = contextPercent(usage)
  return {
    id: 'context',
    label: t('context.label'),
    percent,
    detail:
      usage?.windowTokens && percent !== null
        ? `${shortTokens(usage.usedTokens)} / ${shortTokens(usage.windowTokens)}`
        : t('context.unknown'),
  }
}

export function limitLines(rows: AccountLimitRow[], now: number, t: Translator): UsageLine[] {
  return rows.map((row) => {
    const window = windowLabel(row.window, t)
    return {
      id: row.id,
      label: row.name ? t('limits.named', { name: row.name, window }) : window,
      percent: row.window.usedPercent,
      detail: resetsIn(row.window.resetsAt, now, t),
    }
  })
}

/** 快用完了换提醒的颜色（和桌面的圆环同档） */
export const usageLevel = (percent: number | null): 'normal' | 'high' | 'full' =>
  percent === null ? 'normal' : percent >= 90 ? 'full' : percent >= 70 ? 'high' : 'normal'

/**
 * 手动压缩：harness 声明了不会就不出入口（hidden）；没声明的照旧给，对面说不认识了核心会把 can.compact 记成 false，
 * 那时也不出。回合在跑时压不了，blocked 是说给人听的原因的键
 */
export function compaction(
  can: Pick<SessionView['can'], 'compact' | 'declared'> | undefined,
  running: boolean,
): { shown: boolean; blocked: 'context.compactBusy' | null } {
  if (!can || can.compact === false) return { shown: false, blocked: null }
  return { shown: true, blocked: running ? 'context.compactBusy' : null }
}
