// 选择器顶上的筛选框怎么筛。不碰页面，好单独测。

/** 选项有这么多个起，选择器顶上才放筛选框 */
export const SEARCH_FROM = 8

interface Searchable {
  id: string
  title: string
  note?: string
  /** 不是值、是一件事的那一项（“添加…”）：不参与筛，一直留着 */
  action?: boolean
}

/**
 * 按框里的字留下对得上的选项，先后不变。字按空白拆成几段，每一段都要在标题、标识或说明里出现
 * （不分大小写）；什么都没写就全留。“添加…”那种一件事的项一直留着
 */
export function matchOptions<T extends Searchable>(options: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...options]
  return options.filter((option) => {
    if (option.action) return true
    const text = `${option.title}\n${option.id}\n${option.note ?? ''}`.toLowerCase()
    return words.every((word) => text.includes(word))
  })
}
