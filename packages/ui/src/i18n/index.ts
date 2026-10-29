// 界面的文案。组件里不写死给人看的字，一律 t('键')；核心给的文字（Text）用 t.text(...)。
import type { PhraseKey, Said, Text } from '@litch/core'
import { en } from './en.ts'
import { type Args, type Entry, formatEntry, type Lang } from './types.ts'
import { type MessageKey, zhCN } from './zh-CN.ts'

export type { Args, Lang } from './types.ts'
export type { MessageKey } from './zh-CN.ts'

const CATALOGS: Record<Lang, Record<MessageKey, Entry>> = { 'zh-CN': zhCN, en }

// 核心要说的每一句话在这里都得有文本。少了哪一句，下面这一行就编译不过，报错里会写出是哪一句
type Missing = Exclude<PhraseKey, MessageKey>
const everyPhraseHasText: [Missing] extends [never] ? true : Missing = true
void everyPhraseHasText

export function translate(lang: Lang, key: MessageKey, args: Args = {}): string {
  const entry: Entry = CATALOGS[lang][key]
  return formatEntry(entry, args)
}

export interface Translator {
  (key: MessageKey, args?: Args): string
  /** 核心给的一段文字：原文照出，核心自己要说的话按当前语言说 */
  text(value: Text): string
  /**
   * 设备服务给的话（设置项的标题和说明、没做成的原因）：它两种语言各给了一份，按界面当前的语言取；
   * 只给了一句原话的照出
   */
  said(value: Said): string
  lang: Lang
}

export function translator(lang: Lang): Translator {
  const t = ((key, args) => translate(lang, key, args)) as Translator
  t.text = (value) => (typeof value === 'string' ? value : translate(lang, value.key, value.args))
  t.said = (value) => (typeof value === 'string' ? value : value[lang])
  t.lang = lang
  return t
}
