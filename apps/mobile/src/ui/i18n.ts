// 界面的文案。组件里不写死给人看的字，一律 t('键')；核心给的文字（Text）用 t.text(...)，设备服务给的话用 t.said(...)。
// 两处来源合在一起：桌面界面的文案（packages/ui/src/i18n，核心要说的每一句话都在那里，也有大量现成的界面句子，能用就用）
// 和手机端自己的（./messages/ 下按开发线分的文件，键带前缀，各线只改自己那一份）。
import { getLocales } from 'expo-localization'
import { createContext, useContext } from 'react'
import { type Lang, type MessageKey, translate } from '../../../../packages/ui/src/i18n/index.ts'
import type { Args, Entry } from '../../../../packages/ui/src/i18n/types.ts'
import * as app from './messages/app'
import * as comments from './messages/comments'
import * as compose from './messages/compose'
import * as detail from './messages/detail'
import * as devices from './messages/devices'
import * as hconfig from './messages/hconfig'
import * as pairing from './messages/pairing'
import * as proposals from './messages/proposals'
import * as sessions from './messages/sessions'
import * as tasks from './messages/tasks'
import * as tools from './messages/tools'
import * as update from './messages/update'

export type { Lang } from '../../../../packages/ui/src/i18n/index.ts'

const zhCN = {
  ...app.zhCN,
  ...devices.zhCN,
  ...hconfig.zhCN,
  ...pairing.zhCN,
  ...proposals.zhCN,
  ...sessions.zhCN,
  ...detail.zhCN,
  ...compose.zhCN,
  ...comments.zhCN,
  ...tools.zhCN,
  ...tasks.zhCN,
  ...update.zhCN,
}
type MobileKey = keyof typeof zhCN
const en: Record<MobileKey, Entry> = {
  ...app.en,
  ...devices.en,
  ...hconfig.en,
  ...pairing.en,
  ...proposals.en,
  ...sessions.en,
  ...detail.en,
  ...compose.en,
  ...comments.en,
  ...tools.en,
  ...tasks.en,
  ...update.en,
}
const MOBILE: Record<Lang, Record<MobileKey, Entry>> = { 'zh-CN': zhCN, en }

export type Key = MobileKey | MessageKey

function fill(entry: Entry, args: Args): string {
  if (typeof entry === 'function') return entry(args)
  return entry.replace(/\{(\w+)\}/g, (whole, name: string) => String(args[name] ?? whole))
}

export interface Translator {
  (key: Key, args?: Args): string
  text(value: import('@litch/core').Text): string
  said(value: import('@litch/core').Said): string
  lang: Lang
}

export function translator(lang: Lang): Translator {
  const mobile = MOBILE[lang]
  const t = ((key: Key, args: Args = {}) =>
    key in mobile
      ? fill(mobile[key as MobileKey], args)
      : translate(lang, key as MessageKey, args)) as Translator
  t.text = (value) => (typeof value === 'string' ? value : translate(lang, value.key, value.args))
  t.said = (value) => (typeof value === 'string' ? value : value[lang])
  t.lang = lang
  return t
}

/** 系统语言：中文的各种写法都算中文，其余一律英文 */
export function systemLang(): Lang {
  const tag = getLocales()[0]?.languageTag ?? 'en'
  return tag.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

export const I18nContext = createContext<Translator>(translator('zh-CN'))

export const useT = (): Translator => useContext(I18nContext)
