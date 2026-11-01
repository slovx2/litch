import {
  blockInput,
  bucketItems,
  type ItemView,
  keys,
  originalRanges,
  parseComments,
  processSegments,
  type Replica,
  type SearchHit,
  type TurnView,
} from '@litch/core'
import { expandForSearch } from '../state.ts'

export function revealSearchParents(
  store: Replica['store'],
  deviceId: string,
  sessionId: string,
  hit: Pick<SearchHit, 'itemId' | 'turnId'> | null,
) {
  const scope = `${deviceId}:${sessionId}`
  const ids = new Set<string>()
  if (hit) {
    const { itemId, turnId } = hit
    if (itemId.startsWith('pending:')) ids.add('search-pending')
    ids.add(`search-brief:${itemId}`)
    ids.add(`search-code:${itemId}`)
    ids.add(`search-todo:${turnId}`)
    for (const prefix of ['u', 'i', 'asked', 'ask', 'wrap']) ids.add(`${prefix}:${itemId}`)
    const turn = store.get<TurnView>(keys.turn(deviceId, sessionId, turnId))
    const items = (turn?.itemIds ?? []).flatMap((id) => {
      const item = store.get<ItemView>(keys.item(deviceId, sessionId, id))
      return item ? [blockInput(id, item)] : []
    })
    const blocks = bucketItems(items, { turnRunning: turn?.status === 'running' })
    const segments = processSegments(blocks)
    const first = segments.values().next().value
    for (const [key, segment] of segments)
      if (segment.itemIds.includes(itemId)) {
        ids.add(segment === first ? `p:${turnId}` : `p:${turnId}:${segment.key}`)
        const block = blocks.find((b) => b.type === 'process' && b.key === key)
        if (block?.type === 'process')
          for (const part of block.parts) {
            if (part.type === 'steps' && part.itemIds.includes(itemId)) ids.add(`g:${part.key}`)
          }
      }
    const item = store.get<ItemView>(keys.item(deviceId, sessionId, itemId))
    if (item?.kind === 'userMessage' && (item.event?.body || item.event?.notes.length))
      ids.add(`event:${itemId}`)
    if (item?.kind === 'userMessage')
      for (const c of parseComments(item.text)?.comments ?? []) ids.add(`c:${itemId}:${c.index}`)
  }
  for (const id of [...ids]) ids.add(`v:${id}`)
  expandForSearch(scope, ids)
}

const BLOCK = 'p,pre,li,td,th,h1,h2,h3,h4,h5,h6,div,blockquote'
const SKIP =
  '.message-acts,.umsg-acts,.code-head,.compact-source,.item[data-tone="quiet"] > .item-head,.ask-reply-kind,.cmt-cite,summary,[data-search-skip]'

/** 只读命中消息的 DOM。跨行内标签相连，块边界补空白，不能跨两条消息造出命中。 */
export function searchDOM(roots: Element[], query: string, limit = 500): Range[] {
  let plain = '',
    lastBlock: Element | null = null
  const spans: { node: Text; start: number; end: number }[] = []
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE)
          return (node as Element).tagName === 'BR'
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP
        const parent = node.parentElement
        if (
          !parent ||
          parent.closest(SKIP) ||
          parent.closest(
            'button:not(.ucmt-btn):not(.mention):not(.smen):not(.sev-title):not(.session-mention):not(.compact-message):not(.item-head):not([data-search-option])',
          )
        )
          return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    })
    for (let raw = walker.nextNode(); raw; raw = walker.nextNode()) {
      if (raw.nodeType === Node.ELEMENT_NODE) {
        plain += '\n'
        continue
      }
      const node = raw as Text
      const block = node.parentElement?.closest(BLOCK) ?? null
      if (lastBlock !== block && plain && !/\s$/.test(plain)) plain += '\n'
      spans.push({ node, start: plain.length, end: plain.length + node.data.length })
      plain += node.data
      lastBlock = block
    }
    plain += '\n'
    lastBlock = null
  }
  return originalRanges(plain, query, limit).flatMap((hit) => {
    const start = spans.find((s) => hit.start >= s.start && hit.start < s.end)
    const end = spans.find((s) => hit.end > s.start && hit.end <= s.end)
    if (!start || !end) return []
    const range = document.createRange()
    range.setStart(start.node, hit.start - start.start)
    range.setEnd(end.node, hit.end - end.start)
    return [range]
  })
}
