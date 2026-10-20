// 评论的纯逻辑（不依赖 React，单测直接跑）：回答里的 [N] 改写成能点的记号、片和卡片上的摘要、
// 在对话的行里找评论引用的原文。格式本身（怎么拼进正文、怎么认回来）在核心的 projection/comments.mts。
import type { Row } from '../../core/rows'

const HREF = 'litch-comment:'

export const commentHref = (index: number): string => `${HREF}${index}`

/** litch-comment: 链接指的第几条评论。不是这种链接是 null */
export function parseCommentHref(url: string): number | null {
  if (!url.startsWith(HREF)) return null
  const index = Number(url.slice(HREF.length))
  return Number.isInteger(index) && index > 0 ? index : null
}

/** [N]：后面紧跟着 ( [ : 的是链接、引用式链接的定义，不算 */
const REF = /\[(\d{1,2})\](?![([:])/g
const CODE = /`[^`\n]*`/g

/**
 * 回答里指向评论的 [N] 改写成链接 [label(N)](litch-comment:N)，交给 Markdown 组件画成能点的字。
 * count 是这一回合的用户消息带了几条评论，编号超出的照原文。代码块、缩进的代码、行内代码里的不动；
 * 前一个字是 ] 或 ! 的（[a][1]、![1]）也不动
 */
export function linkCommentRefs(text: string, count: number, label: (n: number) => string): string {
  if (count <= 0 || !text.includes('[')) return text
  const lines = text.split('\n')
  let fence: string | null = null
  let changed = false
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? ''
    const trimmed = line.trimStart()
    if (fence) {
      if (trimmed.startsWith(fence)) fence = null
      continue
    }
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      fence = trimmed.slice(0, 3)
      continue
    }
    if (/^( {4}|\t)/.test(line) || !line.includes('[')) continue
    let out = ''
    let from = 0
    for (const code of line.matchAll(CODE)) {
      out += linkProse(line.slice(from, code.index), count, label) + code[0]
      from = code.index + code[0].length
    }
    out += linkProse(line.slice(from), count, label)
    if (out !== line) {
      lines[at] = out
      changed = true
    }
  }
  return changed ? lines.join('\n') : text
}

function linkProse(prose: string, count: number, label: (n: number) => string): string {
  return prose.replace(REF, (whole, digits: string, offset: number) => {
    const before = offset > 0 ? prose[offset - 1] : ''
    const index = Number(digits)
    if (before === ']' || before === '!' || index < 1 || index > count) return whole
    return `[${label(index)}](${commentHref(index)})`
  })
}

/** 一行摘要：空白并成一个空格，长了截掉加省略号 */
export function snippet(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 拿去在行里找的那一截：引用的第一行非空的字，最多 40 个。块是在空行处切的，第一行一定落在一块里 */
function probeOf(quote: string): string {
  const line = quote.split('\n').find((each) => each.trim()) ?? ''
  return line.trim().slice(0, 40)
}

/** 从发出去的消息里认回来的评论（回退后放回输入框的）不知道原文在哪个条目，条目标识写这个 */
export const UNKNOWN_ITEM = '?'

/**
 * 在对话里找原文时给的线索：草稿里的评论知道条目；发出去的评论只有引用，知道在哪一回合发的；
 * 两样都不知道的在整个对话里找
 */
export interface QuoteTarget {
  quote: string
  itemId?: string
  turnId?: string
}

/**
 * 评论引用的原文在哪一行（行从新到旧排，和对话区的数据一样）。找不到是 -1。
 * 知道条目的先在那条回答的块里找引用开头那一截，找不到就落在那条回答的第一块；
 * 只知道回合的，从那一回合往前（更早的行）找回答的块，计划不算
 */
export function findQuote(rows: readonly Row[], target: QuoteTarget): number {
  const probe = probeOf(target.quote)
  if (target.itemId !== undefined && target.itemId !== UNKNOWN_ITEM) {
    let first = -1
    for (let at = 0; at < rows.length; at++) {
      const row = rows[at]
      if (row?.type !== 'md' || row.itemId !== target.itemId) continue
      if (probe && row.text.includes(probe)) return at
      // 从新到旧排：同一条回答越往后越靠前，留着最后看到的那块
      first = at
    }
    return first
  }
  if (!probe) return -1
  let start = 0
  for (let at = 0; target.turnId !== undefined && at < rows.length; at++) {
    const row = rows[at]
    if (row && 'turnId' in row && row.turnId === target.turnId) start = at + 1
  }
  for (let at = start; at < rows.length; at++) {
    const row = rows[at]
    if (row?.type === 'md' && !row.plan && row.text.includes(probe)) return at
  }
  return -1
}
