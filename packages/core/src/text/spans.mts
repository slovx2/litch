// 把上色库给的那段 HTML 变成一棵只有“带类名的片段”和“文字”的树，界面照着它生成元素。
// 上色库的输出很简单：代码原文（已转义）外面套一层层 <span class="...">。这里只认这一种标签，
// 别的一律当文字，所以不管原文里有什么，界面上都不会多出别的元素来。

export type SpanNode = string | { cls: string; children: SpanNode[] }

const TAG = /<span class="([^"<>]*)">|<\/span>/g

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'",
}

const plain = (text: string): string =>
  text.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (entity) => ENTITIES[entity] ?? entity)

export function parseSpans(html: string): SpanNode[] {
  const root: SpanNode[] = []
  const stack: SpanNode[][] = [root]
  const push = (text: string) => {
    if (text) stack[stack.length - 1]?.push(plain(text))
  }
  let at = 0
  for (const match of html.matchAll(TAG)) {
    push(html.slice(at, match.index))
    at = match.index + match[0].length
    if (match[1] !== undefined) {
      const children: SpanNode[] = []
      stack[stack.length - 1]?.push({ cls: match[1], children })
      stack.push(children)
    } else if (stack.length > 1) {
      stack.pop()
    }
    // 多出来的 </span> 没有对应的开头，直接丢掉
  }
  push(html.slice(at))
  return root
}

/** 这棵树里的文字连起来。应该和上色之前的原文一模一样 */
export function spanText(nodes: SpanNode[]): string {
  let text = ''
  for (const node of nodes) text += typeof node === 'string' ? node : spanText(node.children)
  return text
}

/**
 * 把这棵树按行切开：每一行是一棵自己的小树，跨行的片段（多行注释、多行字符串）在每一行上各开一次。
 * 文件查看器一行一行地画、只画看得见的行，所以要的是“第几行长什么样”。
 * 行数和原文按 \n 切出来的一样多。
 */
export function splitSpanLines(nodes: SpanNode[]): SpanNode[][] {
  const lines: SpanNode[][] = []
  let line: SpanNode[] = []
  /** 现在开着的各层片段的类名，从外到里 */
  const classes: string[] = []
  /** 这一行里各层对应的容器，最外面是这一行自己 */
  let tops: SpanNode[][] = [line]
  const put = (node: SpanNode) => tops[tops.length - 1]?.push(node)
  const open = (cls: string) => {
    const children: SpanNode[] = []
    put({ cls, children })
    tops.push(children)
  }
  const newLine = () => {
    lines.push(line)
    line = []
    tops = [line]
    for (const cls of classes) open(cls)
  }
  const walk = (list: SpanNode[]) => {
    for (const node of list) {
      if (typeof node !== 'string') {
        open(node.cls)
        classes.push(node.cls)
        walk(node.children)
        classes.pop()
        tops.pop()
        continue
      }
      let from = 0
      for (;;) {
        const at = node.indexOf('\n', from)
        const piece = at < 0 ? node.slice(from) : node.slice(from, at)
        if (piece) put(piece)
        if (at < 0) break
        newLine()
        from = at + 1
      }
    }
  }
  walk(nodes)
  lines.push(line)
  return lines
}
