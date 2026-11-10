// 选择器顶上的筛选框怎么筛。不碰页面，好单独测。

/** 选项有这么多个起，选择器顶上才放筛选框 */
export const SEARCH_FROM = 8

interface Searchable {
  id: string
  title: string
  note?: string | null
  /** 项目可有多个根目录，显示首个，搜索全部。 */
  searchText?: string
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

/** 项目按名称和路径筛选；名称命中在前，同类保留设备原有顺序，操作项留在末尾。 */
export function matchProjects<T extends Searchable>(options: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...options]
  const names: T[] = []
  const mixed: T[] = []
  const paths: T[] = []
  const actions: T[] = []
  for (const option of options) {
    if (option.action) {
      actions.push(option)
      continue
    }
    const title = option.title.toLowerCase()
    const text = `${title}\n${option.searchText ?? option.note ?? ''}`.toLowerCase()
    if (!words.every((word) => text.includes(word))) continue
    const hits = words.filter((word) => title.includes(word)).length
    ;(hits === words.length ? names : hits > 0 ? mixed : paths).push(option)
  }
  return [...names, ...mixed, ...paths, ...actions]
}
