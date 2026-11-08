// 把 CDP 的可访问性树（Accessibility.getFullAXTree）排成给模型读的文字：一行一个节点，缩进表示层级，
// 能操作的节点带编号（[ref=e12]），编号背后是 DOM 节点的 backendNodeId，点、输入时按它找元素。
// 以及“和上次比变了什么”的逐行差异。纯函数，单元测试在 test/browser-ax.test.mts。

/** getFullAXTree 回来的节点，只取用得到的字段 */
export interface AxNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: unknown }
  name?: { value?: unknown }
  value?: { value?: unknown }
  properties?: Array<{ name: string; value?: { value?: unknown } }>
  childIds?: string[]
  parentId?: string
  backendDOMNodeId?: number
}

/** 编号簿：同一个标签里同一个元素的编号不变，快照之间能对上 */
export interface RefBook {
  /** 编号 → backendNodeId */
  byRef: Map<string, number>
  /** backendNodeId → 编号 */
  byNode: Map<number, string>
  next: number
}

export const newRefBook = (): RefBook => ({ byRef: new Map(), byNode: new Map(), next: 1 })

/** 一次快照最多多少行、多少字。再多的截掉并说明 */
export const SNAPSHOT_MAX_LINES = 1500
export const SNAPSHOT_MAX_CHARS = 60_000

/** 能操作的角色：这些节点一定给编号 */
const ACTIONABLE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'treeitem',
  'textField',
  'TextField',
  'PopUpButton',
  'ComboBoxSelect',
  'ComboBoxMenuButton',
])

/** 不单独成行、只把孩子往上提的角色 */
const TRANSPARENT = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak'])

/** 标在行尾的状态 */
const FLAGS = ['checked', 'selected', 'expanded', 'pressed', 'disabled', 'required', 'focused']

const text = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''

const clip = (value: string, most: number) =>
  value.length > most ? `${value.slice(0, most)}…` : value

const quote = (value: string) => JSON.stringify(clip(value.replace(/\s+/g, ' ').trim(), 160))

/** 排一个框架的树。book 里的编号会跟着加 */
export function formatAxTree(nodes: readonly AxNode[], book: RefBook, indent = 0): string[] {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const lines: string[] = []
  const roots = nodes.filter((node) => !node.parentId || !byId.has(node.parentId))
  const seen = new Set<string>()

  const walk = (node: AxNode, depth: number, parentName: string) => {
    if (seen.has(node.nodeId)) return
    seen.add(node.nodeId)
    const role = text(node.role?.value)
    const name = text(node.name?.value)
    const props = new Map((node.properties ?? []).map((prop) => [prop.name, prop.value?.value]))
    // 和上一层同名的文字是重复的（按钮、链接的字就是它的名字）
    const duplicate = role === 'StaticText' && name.trim() === parentName.trim()
    const skip =
      node.ignored === true ||
      TRANSPARENT.has(role) ||
      duplicate ||
      (role === 'StaticText' && name.trim() === '') ||
      role === 'RootWebArea'
    let childDepth = depth
    let nextParent = parentName
    if (!skip) {
      const parts = [`${'  '.repeat(depth + indent)}- ${role === 'StaticText' ? 'text' : role}`]
      if (name.trim() !== '') parts.push(quote(name))
      const value = text(node.value?.value)
      if (value !== '' && value !== name) parts.push(`value=${quote(value)}`)
      const level = props.get('level')
      if (typeof level === 'number') parts.push(`level=${level}`)
      for (const flag of FLAGS) {
        const on = props.get(flag)
        if (on === true || on === 'true' || on === 'mixed')
          parts.push(on === 'mixed' ? `${flag}=mixed` : flag)
      }
      const focusable = props.get('focusable') === true
      const target = node.backendDOMNodeId
      if (target !== undefined && (ACTIONABLE.has(role) || focusable)) {
        let ref = book.byNode.get(target)
        if (!ref) {
          ref = `e${book.next++}`
          book.byNode.set(target, ref)
          book.byRef.set(ref, target)
        }
        parts.push(`[ref=${ref}]`)
      }
      lines.push(parts.join(' '))
      childDepth = depth + 1
      nextParent = name
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId)
      if (child) walk(child, childDepth, nextParent)
    }
  }
  for (const root of roots) walk(root, 0, '')
  return lines
}

/** 截到上限以内。回截过之后的行，和有没有截 */
export function capLines(lines: readonly string[]): { lines: string[]; cut: boolean } {
  const out: string[] = []
  let chars = 0
  for (const line of lines) {
    if (out.length >= SNAPSHOT_MAX_LINES || chars + line.length > SNAPSHOT_MAX_CHARS) {
      return { lines: out, cut: true }
    }
    out.push(line)
    chars += line.length + 1
  }
  return { lines: out, cut: false }
}

/** 逐行差异算得过来的上限（两边行数的乘积）。再大就直接给全文 */
const DIFF_BUDGET = 4_000_000

/**
 * 两次快照逐行比：回变了的行，加的前面是“+ ”，去掉的是“- ”，次序照新的那份。
 * 太大算不过来时回 null（调用的人给全文）
 */
export function diffLines(before: readonly string[], after: readonly string[]): string[] | null {
  const n = before.length
  const m = after.length
  if (n * m > DIFF_BUDGET) return null
  // 最长公共子序列，自底向上
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        before[i] === after[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0)
    }
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      i++
      j++
    } else if (
      j < m &&
      (i >= n || (table[i * width + j + 1] ?? 0) >= (table[(i + 1) * width + j] ?? 0))
    ) {
      out.push(`+ ${after[j]}`)
      j++
    } else {
      out.push(`- ${before[i]}`)
      i++
    }
  }
  return out
}
