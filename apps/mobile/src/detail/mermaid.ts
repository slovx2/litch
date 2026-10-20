// mermaid 代码块在手机上不画图（第一版），照源码显示；这个 Markdown 组件不显示围栏上的语言，
// 所以在块前面插一行小字，说明这是 mermaid、去桌面端看图。只认不在别的代码块里的围栏。
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

export function labelMermaid(text: string, label: string): string {
  if (!/mermaid/i.test(text)) return text
  const lines = text.split('\n')
  const out: string[] = []
  let open: string | null = null
  for (const line of lines) {
    const fence = FENCE.exec(line)
    if (open === null && fence) {
      open = fence[1] ?? null
      if (fence[2]?.trim().split(/\s+/)[0]?.toLowerCase() === 'mermaid') out.push(`*${label}*`, '')
    } else if (
      open !== null &&
      fence &&
      fence[1]?.[0] === open[0] &&
      (fence[1]?.length ?? 0) >= open.length &&
      !fence[2]?.trim()
    ) {
      open = null
    }
    out.push(line)
  }
  return out.join('\n')
}
