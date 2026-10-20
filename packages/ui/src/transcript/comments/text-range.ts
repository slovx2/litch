// 一条回答里的“字的位置”：选区换成起止数字存着，之后再从数字换回选区（标原文、跳原文）。
// 只数回答正文里的字，按钮、代码块顶上那一条、回答里的评论记号不算，数法前后一致才对得上。

/** 回答正文的根：带着它所在条目的标识 */
export const ITEM_ATTR = 'data-comment-item'

/** 这些里面的字不算正文 */
const SKIP = 'button, .code-head, .cmt-cite, [data-comment-skip]'

/** 这条回答里算正文的那些文字节点，按先后排 */
export function textNodes(root: Element): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  return nodes
}

/** 正文的全部字（同一种数法） */
export const plainOf = (nodes: Text[]): string => nodes.map((node) => node.data).join('')

/** 一个位置（节点加偏移）前面有多少个字 */
export function offsetOf(nodes: Text[], container: Node, offset: number, root: Element): number {
  const probe = document.createRange()
  probe.setStart(root, 0)
  probe.setEnd(container, offset)
  let count = 0
  for (const node of nodes) {
    if (node === container) return count + offset
    // 这个节点的末尾在位置后面：它整个在位置后面（位置不在它里面）
    if (probe.comparePoint(node, node.length) > 0) break
    count += node.length
  }
  return count
}

/** 起止数字换回选区。超出正文的返回 null */
export function rangeAt(nodes: Text[], start: number, end: number): Range | null {
  if (start < 0 || end <= start) return null
  const range = document.createRange()
  let count = 0
  let begun = false
  for (const node of nodes) {
    const next = count + node.length
    if (!begun && start < next) {
      range.setStart(node, start - count)
      begun = true
    }
    if (begun && end <= next) {
      range.setEnd(node, end - count)
      return range
    }
    count = next
  }
  return null
}

/** 只留字母和数字、统一小写：Markdown 的记号、换行和空白都不算，原文和画出来的字才比得上 */
const KEEP = /[\p{L}\p{N}]/u

export function squeeze(text: string): string {
  let out = ''
  for (const char of text) if (KEEP.test(char)) out += char.toLowerCase()
  return out
}

/**
 * 在正文里找一段引用，返回起止（正文的数法）。先找原样的；找不到就忽略记号和空白再找。
 * near：有几处时挑离它最近的
 */
export function findQuote(plain: string, quote: string, near = 0): [number, number] | null {
  const exact = closest(plain, quote, near)
  if (exact >= 0) return [exact, exact + quote.length]
  const wanted = squeeze(quote)
  if (!wanted) return null
  // 留下来的每个字在原文里的位置
  const kept: number[] = []
  let squeezed = ''
  let at = 0
  for (const char of plain) {
    if (KEEP.test(char)) {
      kept.push(at)
      squeezed += char.toLowerCase()
    }
    at += char.length
  }
  const found = closest(squeezed, wanted, near)
  if (found < 0) return null
  const first = kept[found] ?? 0
  const last = kept[found + wanted.length - 1] ?? first
  // 末尾那个字可能是两个码元（表情、生僻字）
  const tail = plain.codePointAt(last) ?? 0
  return [first, last + (tail > 0xffff ? 2 : 1)]
}

function closest(text: string, part: string, near: number): number {
  if (!part) return -1
  let best = -1
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + 1)) {
    if (best < 0 || Math.abs(at - near) < Math.abs(best - near)) best = at
  }
  return best
}

/** 一条回答正文的根 */
export const itemRoot = (scope: ParentNode, itemId: string): Element | null =>
  scope.querySelector(`[${ITEM_ATTR}="${CSS.escape(itemId)}"]`)

/**
 * 按引用找原文在哪条回答里，从后往前，取第一条找得到的。条目的标识不是一直不变的
 * （重开应用之后会话从记录里重新读出来，标识可能换了写法），按标识找不到时用它
 */
export function rootByQuote(scope: ParentNode, quote: string): Element | null {
  const roots = [...scope.querySelectorAll(`[${ITEM_ATTR}]`)]
  for (let at = roots.length - 1; at >= 0; at--) {
    const root = roots[at]
    if (root && findQuote(plainOf(textNodes(root)), quote)) return root
  }
  return null
}
