/** Android Hermes 能匹配带文字系统的标签；zh-CN 在系统语言为英语时会退回英语。 */
export function formattingLocale(lang: string): string {
  return lang === 'zh-CN' ? 'zh-Hans-CN' : lang
}
