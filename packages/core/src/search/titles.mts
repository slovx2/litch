import type { TitleHit } from './model.mjs'
import { searchQuery, searchText } from './text.mjs'

/** 只按展示标题搜；不把目录、首句或正文暗中混进标题匹配。 */
export function matchTitles(
  rows: Iterable<TitleHit>,
  query: string,
  limit = 100,
  untitled = '',
): {
  hits: TitleHit[]
  hasMore: boolean
} {
  const cap = Math.max(1, Math.min(500, limit))
  const wanted = searchQuery(query)
  const matches = [...rows]
    .filter(
      ({ session }) =>
        session.searchable !== false &&
        searchText(typeof session.title === 'string' ? session.title : untitled).includes(wanted),
    )
    .sort(
      (a, b) =>
        b.session.updatedAt - a.session.updatedAt || a.session.id.localeCompare(b.session.id),
    )
  return {
    hits: matches.slice(0, cap),
    hasMore: matches.length > cap,
  }
}
