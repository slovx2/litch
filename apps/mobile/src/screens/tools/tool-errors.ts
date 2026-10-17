// 一件事没做成的原因，放进“没开成：{reason}”这类句子里。照桌面端 packages/ui/src/app/errors.ts 的 reasonOf：
// 核心说得出是哪一句的按当前语言说，设备服务两种语言都给了的说当前语言那份，别的是对面的原话
import type { Bilingual, Text } from '@litch/core'
import type { Translator } from '../../ui/i18n'

export function reasonOf(error: unknown, t: Translator): string {
  const { text, said } = (error ?? {}) as { text?: Text; said?: Bilingual }
  if (text) return t.text(text)
  if (said) return t.said(said)
  const { message } = (error ?? {}) as { message?: unknown }
  return typeof message === 'string' && message ? message : String(error)
}
