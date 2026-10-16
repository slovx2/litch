export type Lang = 'zh-CN' | 'en'

/** 一句话里要填的值 */
export type Args = Record<string, string | number>

/** 一句话的文本。里面的 {名字} 会换成对应的值；单复数这类规则写不进模板的，用函数 */
export type Entry = string | ((args: Args) => string)
