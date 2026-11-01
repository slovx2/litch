// 搜索匹配独立于 DOM；偏移属于规范化文本，定位时再映射到原文 UTF-16 坐标。
export interface SearchRange {
  start: number
  end: number
}
export const SEARCH_LIMIT = 500
export const SEARCH_QUERY_LIMIT = 256

const lower = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/ς/gu, 'σ')

export function searchText(text: string): string {
  return lower(text).replace(/\s+/gu, ' ')
}

export function searchQuery(text: string): string {
  return Array.from(searchText(text).trim()).slice(0, SEARCH_QUERY_LIMIT).join('')
}

/** 只保留有界的范围，计数仍覆盖全部；空查询不匹配每个字符。 */
export function occurrences(
  text: string,
  query: string,
  limit = SEARCH_LIMIT,
  near = 0,
): {
  ranges: (SearchRange & { ordinal: number })[]
  count: number
} {
  const before: (SearchRange & { ordinal: number })[] = [],
    after: typeof before = []
  if (!query) return { ranges: [], count: 0 }
  let count = 0
  // 环形缓冲只保留起点之前最后 limit 处和之后最初 limit 处，超长单条也有界。
  for (
    let start = text.indexOf(query);
    start >= 0;
    start = text.indexOf(query, start + query.length)
  ) {
    const range = { start, end: start + query.length, ordinal: count++ }
    if (!limit) continue
    if (start <= near) before[(count - 1) % limit] = range
    else if (after.length < limit) after.push(range)
  }
  const ranges = [...before, ...after]
    .sort((a, b) =>
      near === Infinity ? b.start - a.start : Math.abs(a.start - near) - Math.abs(b.start - near),
    )
    .slice(0, limit)
    .sort((a, b) => a.start - b.start)
  return { ranges, count }
}

/** 只在需要画高亮的消息上建坐标表，不给每份历史都保留逐字位置。 */
export function originalRanges(text: string, query: string, limit = SEARCH_LIMIT): SearchRange[] {
  const starts: number[] = [],
    ends: number[] = []
  let normalized = '',
    offset = 0,
    space = false
  for (const { segment: char } of new Intl.Segmenter(undefined, {
    granularity: 'grapheme',
  }).segment(text)) {
    const end = offset + char.length
    if (/\s/u.test(char)) {
      if (space) ends[ends.length - 1] = end
      else {
        normalized += ' '
        starts.push(offset)
        ends.push(end)
      }
      space = true
    } else {
      const lowered = lower(char)
      normalized += lowered
      for (let n = 0; n < lowered.length; n++) {
        starts.push(offset)
        ends.push(end)
      }
      space = false
    }
    offset = end
  }
  return occurrences(normalized, searchQuery(query), limit).ranges.map(({ start, end }) => ({
    start: starts[start]!,
    end: ends[end - 1]!,
  }))
}
