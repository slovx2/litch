import type { HarnessView } from '@litch/core'
import type { Translator } from '../i18n/index.ts'

/** 列表和详情都呈现设备的具体原因，不能只给“按原因处理”而把原文藏起来。 */
export function harnessFailureText(
  harness: HarnessView,
  t: Pick<Translator, 'text' | 'said'>,
): string | null {
  if (harness.state !== 'unavailable') return null
  const reason = harness.reason ? t.text(harness.reason) : null
  const detail = harness.detail ? t.said(harness.detail) : null
  return [...new Set([reason, detail].filter(Boolean))].join('\n') || null
}
