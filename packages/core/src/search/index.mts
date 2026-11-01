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
  query(raw: string, revision: number, order: string[]): SearchResult {
    const query = searchQuery(raw),
      hits: SearchResult['hits'] = []
    let count = 0
    if (!query) return { query, revision, hits, count }
    for (const itemId of order) {
      const doc = this.#documents.get(itemId)
      if (!doc) continue
      const found = occurrences(doc.text, query, SEARCH_LIMIT - hits.length)
      count += found.count
      found.ranges.forEach((range, ordinal) => {
        hits.push({ ...range, itemId, turnId: doc.turnId, ordinal })
      })
    }
    return { query, revision, hits, count }
  }
}
