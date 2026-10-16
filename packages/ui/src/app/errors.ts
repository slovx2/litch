import type { Bilingual, Text } from '@litch/core'
import type { Translator } from '../i18n/index.ts'

/**
 * 这个错误有现成的、能按当前语言说的话就说出来：核心说了是“哪一句”的，
 * 或者设备服务两种语言各给了一份的。都没有就是 null
 */
const said = (error: unknown, t: Translator): string | null => {
  const { text, said: both } = (error ?? {}) as { text?: Text; said?: Bilingual }
  if (text) return t.text(text)
  return both ? t.said(both) : null
}

/**
 * 一件事没做成的原因，放进“没做成：{reason}”这类句子里。
 * 核心说得出是哪一句的（例如某个 harness 现在不可用）按当前语言说；别的是设备那头的原话
 */
export function reasonOf(error: unknown, t: Translator): string {
  return said(error, t) ?? (error instanceof Error ? error.message : String(error))
}

/** 一件事没做成，对人怎么说：核心给了句子的说那一句，能按错误码说清的按错误码说，设备那头给了原因的原样给 */
export function whyNot(error: unknown, t: Translator): string {
  const known = said(error, t)
  if (known) return known
  const { code, message } = (error ?? {}) as { code?: string; message?: string }
  if (code === 'unsupported') return t('ability.unsupported')
  if (code === 'offline') return t('error.offline')
  if (code === 'timeout') return t('error.timeout')
  if (code === 'cancelled') return t('error.cancelled')
  return message || t('error.other')
}
