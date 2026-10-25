// 一块回答里的 mermaid 代码块拆出来单独画成卡片（MermaidCard.tsx），前后的字还交给 Markdown 组件。
// 只认不在别的代码块里、已经写完（围栏闭合）的 mermaid 块；还在流式、没写完的留在字里，照源码显示，写完再画。
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** at：从原文第几行开始。字只往后长，同一段的 at 不变，当 React 的 key 用 */
export type Segment =
  | { kind: 'md'; at: number; text: string }
  | { kind: 'mermaid'; at: number; source: string }

/** 按 mermaid 块切开。没有 mermaid 块时是原样的一段 */
export function splitMermaid(text: string): Segment[] {
  if (!/mermaid/i.test(text)) return [{ kind: 'md', at: 0, text }]
  const lines = text.split('\n')
  const out: Segment[] = []
  /** 还没交出去的字从第几行开始 */
  let from = 0
  /** 开着的围栏，和它是不是 mermaid、从第几行开始 */
  let open: { fence: string; mermaid: boolean; at: number } | null = null
  const flush = (end: number) => {
    const piece = lines
      .slice(from, end)
      .join('\n')
      .replace(/^\s*\n/, '')
      .trimEnd()
    if (piece) out.push({ kind: 'md', at: from, text: piece })
  }
  lines.forEach((line, index) => {
    const fence = FENCE.exec(line)
    if (!fence) return
    const mark = fence[1] ?? ''
    const info = fence[2] ?? ''
    if (open === null) {
      open = {
        fence: mark,
        mermaid: info.trim().split(/\s+/)[0]?.toLowerCase() === 'mermaid',
        at: index,
      }
    } else if (mark[0] === open.fence[0] && mark.length >= open.fence.length && !info.trim()) {
      if (open.mermaid) {
        flush(open.at)
        out.push({
          kind: 'mermaid',
          at: open.at,
          source: lines.slice(open.at + 1, index).join('\n'),
        })
        from = index + 1
      }
      open = null
    }
  })
  flush(lines.length)
  return out.length > 0 ? out : [{ kind: 'md', at: 0, text }]
}
