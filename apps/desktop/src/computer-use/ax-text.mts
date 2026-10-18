// 界面树 → 给模型看的文字（决 253：编号、差异、文本化放在主进程，Windows 先用）。
// 规则照 macOS 助手的 apps/computer-use/Sources/LitchComputerUseCore/AXText.swift，两个平台给模型的文字形状一样：
//   1. 编号：同一个会话、同一个应用里，同一个元素前后几次取状态号码不变；新出现的给新号，号码不重用。
//      “同一个元素”先按助手给的 ref（UIA 的 RuntimeId，同一进程生命周期内稳定）认；没有 ref、或者同一棵树里
//      ref 重了，退回 macOS 的认法：祖先链上每一层的角色和名字（有 automationId 用它），加上同名兄弟里的第几个。
//   2. 排成文字：一行一个元素，缩进表示层级；没有名字、没有值的容器不单占一行，孩子提上来。
//   3. 差异：和上一次比，只列新增、消失、变了的元素；没有上一次时给全文。
// 文字有长度上限，超了在行与行之间截断，并说明省了多少行。长度按字符（码点）算，和 Swift 的 count 一样不按 UTF-16。
import type { WinNode } from './wire.mjs'

/** 排出来的一行 */
export interface AXLine {
  index: number
  depth: number
  /** 不含缩进和编号的内容，差异按它比 */
  content: string
  /** 助手认元素用的引用（动作时交回去） */
  ref: string
  /** 截图像素 */
  frame?: { x: number; y: number; width: number; height: number }
}

/** 全文的默认上限（字符） */
export const DEFAULT_LIMIT = 16_000
/** 动作之后附带的差异的上限 */
export const ACTION_DIFF_LIMIT = 4_000

/** 只是用来套东西、自己没有名字和值的容器（UIA 的控件类型去掉 Control），不单占一行 */
const CONTAINER_ROLES = new Set(['Pane', 'Group', 'Custom', 'Separator', 'Thumb', 'Unknown'])

/** 一个会话里一个应用的编号状态 */
export class AXIndexBook {
  private keyToIndex = new Map<string, number>()
  private next = 1
  /** 上一次排出来的行（按编号），差异用 */
  private previousLines: Map<number, AXLine> | null = null

  get previous(): ReadonlyMap<number, AXLine> | null {
    return this.previousLines
  }

  /** 给一棵树编号、排成行。编号表随之更新：这次不在的元素的号码作废，但不重用 */
  lines(root: WinNode): AXLine[] {
    const result: AXLine[] = []
    const seen = new Map<string, number>()
    const refs = new Set<string>()
    this.walk(root, '', 0, result, seen, refs, new Set())
    this.keyToIndex = seen
    return result
  }

  /** 记下这一次，作为下一次差异的基准 */
  remember(lines: readonly AXLine[]): void {
    const map = new Map<number, AXLine>()
    for (const line of lines) if (!map.has(line.index)) map.set(line.index, line)
    this.previousLines = map
  }

  /** 忘掉基准（模型要全文时） */
  forget(): void {
    this.previousLines = null
  }

  private walk(
    node: WinNode,
    parentKey: string,
    depth: number,
    result: AXLine[],
    seen: Map<string, number>,
    refs: Set<string>,
    used: Set<number>,
  ): void {
    const shown = isShown(node)
    let key = parentKey
    let childDepth = depth
    if (shown) {
      const name = nonEmpty(node.automationId) ?? nonEmpty(node.name) ?? ''
      const base = `${parentKey}/${node.role}:${name}`
      // 同一层里角色和名字都一样的兄弟，按出现的先后区分（ref 认不出时用）
      let ordinal = 0
      while (seen.has(`${base}#${ordinal}`)) ordinal += 1
      const pathKey = `${base}#${ordinal}`
      const ref = nonEmpty(node.ref)
      const refKey = ref && !refs.has(ref) ? `ref:${ref}` : null
      if (ref) refs.add(ref)
      // 两种键都记下：这一次按 ref 认出来的，下一次 ref 变了（Chromium 偶尔重建节点）还能按路径认
      // 一个号码这一次只给一个元素（按 ref 认的和按路径认的可能撞到同一个旧号）
      const byRef = refKey ? this.keyToIndex.get(refKey) : undefined
      const byPath = this.keyToIndex.get(pathKey)
      const known = [byRef, byPath].find((one) => one !== undefined && !used.has(one))
      const index = known ?? this.next++
      used.add(index)
      if (refKey) seen.set(refKey, index)
      seen.set(pathKey, index)
      key = pathKey
      result.push({
        index,
        depth,
        content: describe(node),
        ref: node.ref,
        ...(node.frame ? { frame: node.frame } : {}),
      })
      childDepth = depth + 1
    }
    for (const child of node.children ?? []) {
      this.walk(child, key, childDepth, result, seen, refs, used)
    }
  }
}

export function isShown(node: WinNode): boolean {
  if (!CONTAINER_ROLES.has(node.role)) return true
  return (
    nonEmpty(node.name) !== null ||
    nonEmpty(node.value) !== null ||
    nonEmpty(node.automationId) !== null
  )
}

/** 一个元素的描述：角色、名字、值、状态 */
export function describe(node: WinNode): string {
  let text = node.role
  const name = nonEmpty(node.name)
  if (name !== null) text += ` ${quote(name, 120)}`
  const value = nonEmpty(node.value)
  if (value !== null && value !== name) text += ` = ${quote(value, 300)}`
  if (node.states.length > 0) text += ` {${node.states.join(', ')}}`
  return text
}

/** 全文 */
export function render(lines: readonly AXLine[], limit = DEFAULT_LIMIT): string {
  return cut(
    lines.map((line) => `${'  '.repeat(line.depth)}[${line.index}] ${line.content}`),
    limit,
  )
}

/** 和上一次的差异。没有上一次时回 null（调用方给全文） */
export function diff(
  previous: ReadonlyMap<number, AXLine> | null,
  current: readonly AXLine[],
  limit = DEFAULT_LIMIT,
): string | null {
  if (!previous) return null
  const rows: string[] = []
  const present = new Set<number>()
  for (const line of current) {
    present.add(line.index)
    const before = previous.get(line.index)
    if (!before) rows.push(`+ [${line.index}] ${line.content}`)
    else if (before.content !== line.content) rows.push(`~ [${line.index}] ${line.content}`)
  }
  for (const index of [...previous.keys()].sort((a, b) => a - b)) {
    const before = previous.get(index)
    if (before && !present.has(index)) rows.push(`- [${index}] ${before.content}`)
  }
  if (rows.length === 0) return '(no changes since the last state)'
  return cut(rows, limit)
}

/** 在行与行之间截到上限以内 */
export function cut(rows: readonly string[], limit: number): string {
  let used = 0
  const kept: string[] = []
  for (const row of rows) {
    const cost = length(row) + 1
    if (used + cost > limit && kept.length > 0) break
    kept.push(row)
    used += cost
  }
  let text = kept.join('\n')
  if (kept.length < rows.length) text += `\n… (${rows.length - kept.length} more lines not shown)`
  return text
}

function nonEmpty(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed
}

/** 按码点数 */
function length(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/** 加引号，换行写成 \n，过长截断 */
function quote(text: string, limit: number): string {
  let body = text
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '')
  const chars = [...body]
  if (chars.length > limit) body = `${chars.slice(0, limit).join('')}…`
  return `"${body}"`
}
