// 流式输出时文本是一点点来的，结尾常常停在一个没闭合的标记中间：加粗只来了前一半，
// 行内代码少一个反引号，链接的地址还没写完。原样交给 Markdown 解析会先显示成一串星号，
// 闭合的那一刻再整段变样，看起来就是闪一下。这里在解析之前把结尾补齐，只动最后一段。纯函数。

const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** 文本是不是停在一个没关上的围栏代码块里 */
function insideFence(lines: string[]): boolean {
  let open: string | null = null
  for (const line of lines) {
    const mark = line.match(FENCE)?.[1]
    if (!mark) continue
    if (open === null) open = mark
    else if (mark[0] === open[0] && mark.length >= open.length) open = null
  }
  return open !== null
}

/** 数一个标记在文本里出现了几次，跳过行内代码里的内容 */
function countOutsideCode(text: string, marker: string): number {
  let count = 0
  let inCode = false
  for (let at = 0; at < text.length; at++) {
    if (text[at] === '`') {
      inCode = !inCode
    } else if (!inCode && text.startsWith(marker, at)) {
      count++
      at += marker.length - 1
    }
  }
  return count
}

/** 把最后一段里没闭合的行内标记补上，或者把刚敲出来、后面还没有内容的半个标记去掉 */
function repairTail(tail: string): string {
  let text = tail
  // 链接：方括号写完了，圆括号里的地址还没写完。先只显示文字
  text = text.replace(/\[([^\]\n]*)\]\([^)\n]*$/, '$1')
  // 行内代码：反引号是奇数个，最后那个还没闭合
  if ((text.split('`').length - 1) % 2 === 1) {
    text = text.endsWith('`') ? text.slice(0, -1) : `${text}\``
  }
  for (const marker of ['**', '~~']) {
    if (countOutsideCode(text, marker) % 2 === 0) continue
    // 奇数个：最后那个还没闭合。它后面什么都没有就去掉，有内容就补一个
    text = text.endsWith(marker) ? text.slice(0, -marker.length) : text + marker
  }
  return text
}

/**
 * 给还在往外出字的 Markdown 补齐结尾。已经写完的文本不要过这个函数。
 * 只看最后一个空行之后的那一段；停在代码块里时什么都不动。
 */
export function repairStreamingMarkdown(text: string): string {
  const lines = text.split('\n')
  if (insideFence(lines)) return text
  let start = lines.length - 1
  while (start > 0 && lines[start - 1]?.trim() !== '') start--
  const head = lines.slice(0, start).join('\n')
  const tail = lines.slice(start).join('\n')
  const repaired = repairTail(tail)
  if (repaired === tail) return text
  return start === 0 ? repaired : `${head}\n${repaired}`
}
