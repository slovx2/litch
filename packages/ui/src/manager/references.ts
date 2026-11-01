import type {
  ManagerDecisionId,
  ManagerItemId,
  ManagerRequestId,
} from '../../../core/src/model-manager.mts'

export type BoardReference =
  | ManagerItemId
  | ManagerDecisionId
  | ManagerRequestId
  | `P-${number}`
  | `S-${string}`
export interface ReferencePart {
  text: string
  id?: BoardReference
}

/** 只链接当前看板实际存在的完整编号，避免把单词或更长编号的一部分变成链接。 */
export function boardReferences(text: string, ids: ReadonlySet<BoardReference>): ReferencePart[] {
  const parts: ReferencePart[] = []
  const pattern = /(?<!\w)#?[IDRP]-\d+(?!\w)/g
  let start = 0
  for (const match of text.matchAll(pattern)) {
    const id = match[0].replace(/^#/, '') as BoardReference
    if (!ids.has(id)) continue
    if (match.index > start) parts.push({ text: text.slice(start, match.index) })
    parts.push({ text: match[0], id })
    start = match.index + match[0].length
  }
  if (start < text.length) parts.push({ text: text.slice(start) })
  return parts
}
