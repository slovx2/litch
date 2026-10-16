// 文件内容按行切开，和“一行太长怎么办”。纯函数，好单独测。

/** 一行超过这么多字就只显示开头这一截：太长的一行排版起来整个页面都会卡 */
export const LINE_CUT = 4000
/** 文件里有超过这么长的行（多半是压缩过的代码）就不上色 */
export const LINE_PAINT_MAX = 4000
/** 超过这么多字的文件，上色的工作线程用不了的时候就不上色了（在主线程上色会卡住界面） */
export const MAIN_PAINT_MAX = 100_000

/** 按行切开。文件以换行结尾的，最后那个空行不算一行（和编辑器里看到的行数一样）；空文件是一行 */
export function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 最长的一行有多少字（按 UTF-16 单位，够用来估宽度） */
export function longestLine(lines: readonly string[]): number {
  let most = 0
  for (const line of lines) if (line.length > most) most = line.length
  return most
}

export interface CutLine {
  text: string
  /** 后面没显示的还有多少字。0：整行都在 */
  hidden: number
}

/** 太长的一行只留开头一截。不从一个字的中间切（代理对的两半不拆开） */
export function cutLine(line: string, limit = LINE_CUT): CutLine {
  if (line.length <= limit) return { text: line, hidden: 0 }
  const code = line.charCodeAt(limit - 1)
  const end = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit
  return { text: line.slice(0, end), hidden: line.length - end }
}

/** 字节数给人看的写法 */
export function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 行号那一栏要几位数 */
export const digitsOf = (count: number): number => Math.max(2, String(Math.max(count, 1)).length)
