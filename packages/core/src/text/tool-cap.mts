// 工具调用（MCP、动态工具、函数工具）的参数和结果的上限：太长的只留头尾，中间记下省了多少。
//
// 结果是多段的：文字、图片、音频、内嵌的资源……一个 MCP 工具能回几十 MB 的文字，也能回几千段。
// 不截的话核心和界面各留一整份，展开着看时界面把整段排一遍版，切走再切回来快照又整份重发一遍（和命令输出一样）。
// 上游 TUI 只把文字留下来，图片、音频、资源只留一行说明，所有段合起来按一个上限预览（tui/src/history_cell/mcp_result.rs）；
// 这里也是：文字以外的段在投影时就只剩种类、格式、大小（projection/items.mts），这里只管多长。
//
// 规矩和命令输出是同一套（text/output-cap.mts），看成一整段字来截：
// - 各段按先后排成一段“虚的全文”：文字段是它的字，blob 段是 PART_CHARS 个不是换行的字（它在界面上是一行说明）；
//   段与段之间隔 PART_CHARS 个字，最后一个是换行（界面上每一段都另起一行）。这样每一段至少算 PART_CHARS 个字：
//   几千段图片、几千段只有几个字的文字，留下来的段数也有上限（每一段在条目里、界面上都有它自己的一份开销）。
// - 虚的全文不到 OUTPUT_KEEP 个字时一段都不省。到了就照命令输出的规矩下两刀（cutPoints）：
//   开头留 16K 上下、末尾留 48K–64K 上下，尽量切在行与行之间。段与段之间就是换行，所以离刀口近的段多半整段留或整段省。
// - 刀落在文字段里，这一段只留刀口这一边；落在 blob 段里（找不到换行时才会），整段省掉；落在段与段之间的分隔里，两边的段都不受影响。
// - 中间省掉的地方放一段 gap：省了多少个字、多少个 UTF-8 字节（只算文字段的字，分隔和 blob 不算），一并省掉的 blob 有几段。
// 结果都是整段到的（条目完成、读历史、恢复会话），留下来的样子只由这一份结果决定，三条路一样。
// 只有一段文字时没有分隔，留下来的和命令输出截出来的一模一样。
import type { ToolPart } from '../model.mjs'
import { type CharSource, cutPoints, ownText, utf8Length } from './output-cap.mjs'

/** 一段 blob 在虚的全文里占多少个字，段与段之间的分隔也是这么多 */
export const PART_CHARS = 32

/** blob 在虚的全文里的样子：没有换行的一串 */
const BLOB = '\ufffc'.repeat(PART_CHARS)
/** 段与段之间的分隔：一串不是换行的字，最后一个是换行 */
const JOIN = `${'\ufffc'.repeat(PART_CHARS - 1)}\n`

type Blob = Extract<ToolPart, { kind: 'blob' }>

/**
 * 几段合起来的虚的全文，不真的拼出来（结果可能有几十 MB，找刀口只看两小块）。
 * starts[i] 是第 i 段在全文里从哪开始；取字时记着上一次落在哪一段，找刀口是挨着一个一个字看的，几乎不用重新找
 */
function virtualText(segments: readonly string[]): CharSource & { starts: number[] } {
  const starts: number[] = []
  let length = 0
  for (const segment of segments) {
    if (starts.length > 0) length += JOIN.length
    starts.push(length)
    length += segment.length
  }
  let index = 0
  return {
    starts,
    length,
    charCodeAt(at) {
      if (at < 0 || at >= length) return Number.NaN
      // 落在哪一段（连同它后面的分隔）里：从上一次的那一段往前或往后挪
      while (index > 0 && (starts[index] ?? 0) > at) index--
      while (index + 1 < starts.length && (starts[index + 1] ?? length) <= at) index++
      const segment = segments[index] ?? ''
      const offset = at - (starts[index] ?? 0)
      return offset < segment.length
        ? segment.charCodeAt(offset)
        : JOIN.charCodeAt(offset - segment.length)
    },
  }
}

/** 截过的几段。没超过上限时就是原来那几段（同一个数组） */
export function capParts(parts: ToolPart[]): ToolPart[] {
  const segments = parts.map((part) => (part.kind === 'text' ? part.text : BLOB))
  const whole = virtualText(segments)
  const cut = cutPoints(whole)
  if (!cut) return parts
  const { head, start } = cut
  const kept: ToolPart[] = []
  const tail: ToolPart[] = []
  let chars = 0
  let bytes = 0
  let dropped = 0
  for (const [index, part] of parts.entries()) {
    const from = whole.starts[index] ?? 0
    const to = from + (segments[index]?.length ?? 0)
    if (to <= head) kept.push(part)
    else if (from >= start) tail.push(part)
    else if (part.kind !== 'text') {
      // blob 只有整段留或整段省（gap 不会从投影里来）
      if (part.kind === 'blob') dropped++
    } else {
      // 刀落在这一段里，或者整段都在中间：开头那一截留到 keepTo，末尾那一截从 keepFrom 起。
      // 切下来的拷成自己的一份，不拖着整段原文（见 ownText）
      const { text } = part
      const keepTo = Math.max(0, head - from)
      const keepFrom = Math.min(text.length, start - from)
      if (keepTo > 0) kept.push({ kind: 'text', text: ownText(text.slice(0, keepTo)) })
      if (keepFrom > keepTo) {
        chars += keepFrom - keepTo
        bytes += utf8Length(text, keepTo, keepFrom)
      }
      if (keepFrom < text.length) tail.push({ kind: 'text', text: ownText(text.slice(keepFrom)) })
    }
  }
  return [...kept, { kind: 'gap', chars, bytes, parts: dropped }, ...tail]
}

/** 一段 blob。没有的项给 null */
export const blob = (
  type: Blob['type'],
  fields: Partial<Omit<Blob, 'kind' | 'type'>> = {},
): Blob => ({
  kind: 'blob',
  type,
  mime: fields.mime ?? null,
  bytes: fields.bytes ?? null,
  name: fields.name ?? null,
})
