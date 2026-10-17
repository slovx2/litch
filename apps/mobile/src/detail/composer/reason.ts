// 一件事没做成的原因怎么说（照桌面端 packages/ui/src/app/errors.ts）：核心说了是“哪一句”的、设备服务两种语言
// 各给了一份的，按当前语言说；能按错误码说清的按错误码说；别的是设备那头的原话。
import type { Bilingual, Text } from '@litch/core'
import type { Translator } from '../../ui/i18n'

const said = (error: unknown, t: Translator): string | null => {
  const { text, said: both } = (error ?? {}) as { text?: Text; said?: Bilingual }
  if (text) return t.text(text)
  return both ? t.said(both) : null
}

/** 放进“没做成：{reason}”这类句子里的那一段 */
export function reasonOf(error: unknown, t: Translator): string {
  const known = said(error, t)
  if (known) return known
  const { code, message } = (error ?? {}) as { code?: string; message?: string }
  if (code === 'unsupported') return t('ability.unsupported')
  if (code === 'offline') return t('error.offline')
  if (code === 'timeout') return t('error.timeout')
  if (code === 'cancelled') return t('error.cancelled')
  return message || t('error.other')
}
