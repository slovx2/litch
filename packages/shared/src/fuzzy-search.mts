// 返回 Unicode 字符位置，避免中文和代理对导致客户端高亮错位。
export function fuzzyPathMatch(
  query: string,
  path: string,
): { score: number; indices: number[] } | null {
  const needle = Array.from(query.toLowerCase())
  const chars = Array.from(path)
  if (!needle.length) return { score: 1, indices: [] }
  const indices: number[] = []
  let cursor = 0
  for (const char of needle) {
    while (cursor < chars.length && chars[cursor]?.toLowerCase() !== char) cursor++
    if (cursor === chars.length) return null
    indices.push(cursor++)
  }
  const first = indices[0] ?? 0
  const span = (indices.at(-1) ?? first) - first + 1
  const basename = chars.lastIndexOf('/') + 1
  const gaps = span - needle.length
  // 优先完整文件名和连续匹配；分数只用于排序，不承诺复制 Codex 的内部算法。
  const exactName = chars.slice(basename).join('').toLowerCase() === query.toLowerCase()
  const score = Math.max(
    1,
    1000 +
      (exactName ? 500 : 0) +
      (first === basename ? 100 : 0) +
      needle.length * 10 -
      gaps * 4 -
      first -
      chars.length,
  )
  return { score, indices }
}
