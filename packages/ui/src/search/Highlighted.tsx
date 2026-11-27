import { originalRanges } from '@litch/core'

/** 原文里和查询匹配的几段包进 mark；查询为空或没有匹配时原样输出 */
export function Highlighted({ text, query }: { text: string; query: string }) {
  const spans = query ? originalRanges(text, query) : []
  let end = 0
  const content = spans.flatMap((span) => {
    const before = text.slice(end, span.start)
    end = span.end
    return [before, <mark key={span.start}>{text.slice(span.start, span.end)}</mark>]
  })
  return (
    <>
      {content}
      {text.slice(end)}
    </>
  )
}
