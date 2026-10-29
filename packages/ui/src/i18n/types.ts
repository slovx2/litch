export type Lang = 'zh-CN' | 'en'

/** 一句话里要填的值 */
export type Args = Record<string, string | number>

/** 一句话的文本。里面的 {名字} 会换成对应的值；单复数这类规则写不进模板的，用函数 */
export type Entry = string | ((args: Args) => string)

/** 全局文案和独立渲染器文案使用同一套插值规则。 */
export function formatEntry(entry: Entry, args: Args = {}): string {
  if (typeof entry === 'function') return entry(args)
  return entry.replace(/\{(\w+)\}/g, (whole, name: string) => String(args[name] ?? whole))
}
