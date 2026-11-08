export interface ObservationSlice {
  text: string
  truncated: boolean
  next_offset?: number
  total_lines: number
}

/** 只在行间分页；offset 是原始行号，最后的控件不会因为前面的长列表而无法访问。 */
export function observationSlice(
  lines: readonly string[],
  options: { full?: boolean; offset?: number } = {},
): ObservationSlice {
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  const maxLines = options.full ? 1500 : 180
  const maxChars = options.full ? 60_000 : 10_000
  const kept: string[] = []
  let chars = 0
  for (const line of lines.slice(offset)) {
    if (kept.length >= maxLines || (chars + line.length > maxChars && kept.length > 0)) break
    kept.push(line)
    chars += line.length + 1
  }
  const next = offset + kept.length
  const truncated = next < lines.length
  return {
    text: kept.join('\n'),
    truncated,
    total_lines: lines.length,
    ...(truncated ? { next_offset: next } : {}),
  }
}
