import type { SearchPart } from './items.mjs'
import { itemSearchParts } from './items.mjs'
import type { SearchResult, SearchSource } from './model.mjs'
import { occurrences, SEARCH_LIMIT, searchQuery, searchText } from './text.mjs'

/** 可在 Web Worker、手机执行器或测试进程运行；完成项只在其内容变化时重新提取。 */
export class ConversationSearch {
  readonly #documents = new Map<string, { turnId: string; text: string }>()
  readonly #format: (parts: SearchPart[]) => string
  constructor(format: (parts: SearchPart[]) => string) {
    this.#format = format
  }
  update(sources: SearchSource[], removed: string[]): void {
    for (const id of removed) this.#documents.delete(id)
    for (const { turnId, item } of sources) {
      const parts = itemSearchParts(item)
      if (parts.length)
        this.#documents.set(item.id, { turnId, text: searchText(this.#format(parts)) })
      else this.#documents.delete(item.id)
    }
  }
  query(
    raw: string,
    revision: number,
    order: string[],
    anchor?: { itemId: string; start: number },
  ): SearchResult {
    const query = searchQuery(raw),
      hits: SearchResult['hits'] = []
    let count = 0
    if (!query) return { query, revision, hits, count }
    const positions = new Map(order.map((id, i) => [id, i]))
    const origin = anchor ? (positions.get(anchor.itemId) ?? order.length - 1) : order.length - 1
    // 先选离视口最近的条目；容量用尽后仍计数，最后还原对话顺序。
    const nearby = [...order].sort(
      (a, b) =>
        Math.abs(positions.get(a)! - origin) - Math.abs(positions.get(b)! - origin) ||
        positions.get(b)! - positions.get(a)!,
    )
    let nearest = ''
    for (const itemId of nearby) {
      const doc = this.#documents.get(itemId)
      if (!doc) continue
      const near =
        itemId === anchor?.itemId ? anchor.start : positions.get(itemId)! <= origin ? Infinity : 0
      const found = occurrences(doc.text, query, SEARCH_LIMIT - hits.length, near)
      count += found.count
      const selected = found.ranges.map((range) => ({
        ...range,
        itemId,
        turnId: doc.turnId,
        ordinal: range.ordinal,
      }))
      if (!nearest && selected.length) {
        const closest = [...selected].sort((a, b) =>
          near === Infinity
            ? b.start - a.start
            : Math.abs(a.start - near) - Math.abs(b.start - near),
        )[0]!
        nearest = `${closest.itemId}:${closest.ordinal}`
      }
      hits.push(...selected)
    }
    hits.sort((a, b) => positions.get(a.itemId)! - positions.get(b.itemId)! || a.start - b.start)
    return {
      query,
      revision,
      hits,
      count,
      nearest: Math.max(
        0,
        hits.findIndex((h) => `${h.itemId}:${h.ordinal}` === nearest),
      ),
    }
  }
}
