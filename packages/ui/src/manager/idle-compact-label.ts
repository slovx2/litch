import type { ManagerIdleCompactRecord } from '@litch/core'
import { stampFull } from '../app/format.ts'
import type { Translator } from '../i18n/index.ts'

export function idleCompactLabel(record: ManagerIdleCompactRecord, t: Translator) {
  const format = (percent: number) =>
    new Intl.NumberFormat(t.lang, { maximumFractionDigits: 1 }).format(percent)
  const info = { at: stampFull(record.at, t.lang), before: format(record.before) }
  return record.after === null
    ? t('manager.idleCompact.lastUnknown', info)
    : t('manager.idleCompact.last', { ...info, after: format(record.after) })
}
