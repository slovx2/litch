// 输入框里提到的会话（正文里的 @[标题]）画成片：哪几段是片、光标和选区不落进片里、退格整片删。
// 输入框仍是 textarea，正文、草稿、发出去的字都还是 @[标题]，片只是盖在上面的一层显示（MentionField.tsx）。
// 纯逻辑：test/mention-field.test.mjs 直接引这个文件，所以只用可擦除的语法、不引样式和组件，也不引核心的实现。
import { mentionSpots } from '../../../protocol/src/session-mentions.mts'

/** 输入框里记下的一个会话 */
export interface DraftMention {
  threadId: string
  title: string
}

/** 正文里画成片的一段：[start, end) 是整个 @[标题] */
export interface MentionRange extends DraftMention {
  start: number
  end: number
}

/**
 * 正文里对上了记下的会话的 @[标题]：和核心发出去时一样（sentText 换掉所有标题对得上的、mentionSegments 依次对给同标题的），
 * 代码块里的、标题对不上的不算
 */
export function mentionRanges(text: string, bound: readonly DraftMention[]): MentionRange[] {
  if (bound.length === 0 || !text.includes('@[')) return []
  const used = new Map<string, number>()
  const ranges: MentionRange[] = []
  for (const spot of mentionSpots(text)) {
    const same = bound.filter((one) => one.title === spot.title)
    if (same.length === 0) continue
    const nth = used.get(spot.title) ?? 0
    used.set(spot.title, nth + 1)
    const one = same[Math.min(nth, same.length - 1)] as DraftMention
    ranges.push({ start: spot.start, end: spot.end, threadId: one.threadId, title: one.title })
  }
  return ranges
}

/** 一个位置落在哪片的里面（不含两头） */
const inside = (ranges: readonly MentionRange[], at: number): MentionRange | undefined =>
  ranges.find((range) => at > range.start && at < range.end)

/**
 * 落在片里面的一头挪到片的边上：原来在片前面（往后移进来的）挪到片尾，原来在片后面挪到片头，
 * 说不清从哪来的（点进来的）挪到近的那头
 */
function snapEdge(ranges: readonly MentionRange[], at: number, before: number | null): number {
  const range = inside(ranges, at)
  if (!range) return at
  if (before !== null && before <= range.start) return range.end
  if (before !== null && before >= range.end) return range.start
  return at - range.start <= range.end - at ? range.start : range.end
}

/**
 * 光标、选区不落进片里。折叠的光标按从哪来挪到片头或片尾；选区的两头各自挪，
 * 只有一头动了的（Shift 加方向键）按那一头从哪来挪，没动的那头落在片里时扩到整片。
 * 返回新的选区，用不着挪返回 null
 */
export function snapSelection(
  ranges: readonly MentionRange[],
  selection: { start: number; end: number },
  previous: { start: number; end: number } | null,
): { start: number; end: number } | null {
  const { start, end } = selection
  if (ranges.length === 0 || (!inside(ranges, start) && !inside(ranges, end))) return null
  if (start === end) {
    const at = snapEdge(
      ranges,
      start,
      previous ? (previous.start === previous.end ? previous.start : null) : null,
    )
    return { start: at, end: at }
  }
  // 选区：动了的那头按从哪来挪，没动的那头扩出去包住整片
  const startMoved = previous ? previous.start !== start : true
  const endMoved = previous ? previous.end !== end : true
  let from = start
  let to = end
  const head = inside(ranges, start)
  if (head) from = startMoved && previous ? snapEdge(ranges, start, previous.start) : head.start
  const tail = inside(ranges, end)
  if (tail) to = endMoved && previous ? snapEdge(ranges, end, previous.end) : tail.end
  if (from > to) from = to
  return { start: from, end: to }
}

/**
 * 按退格或删除键时要整片删掉的范围：光标紧挨在片后面按退格、紧挨在片前面按删除。
 * 选了一段的、不挨着片的交给输入框自己删，返回 null
 */
export function chipToDelete(
  ranges: readonly MentionRange[],
  selection: { start: number; end: number },
  key: 'Backspace' | 'Delete',
): MentionRange | null {
  if (selection.start !== selection.end) return null
  const at = selection.start
  return (
    ranges.find((range) => (key === 'Backspace' ? range.end === at : range.start === at)) ?? null
  )
}

/**
 * 拦不住按键的输入框（手机）只能看改完的字：这一下只删了字、又只删到片的一部分（退格删了 ]），
 * 把碰到的片整片一起删掉。返回补删后的字和光标，用不着补的返回 null
 */
export function chipEdit(
  before: string,
  after: string,
  ranges: readonly MentionRange[],
): { text: string; caret: number } | null {
  if (ranges.length === 0 || after.length >= before.length) return null
  let head = 0
  while (head < after.length && before[head] === after[head]) head += 1
  let tail = 0
  while (
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail += 1
  // 还插了别的字（选中一段打字替换）：不是单纯的删除，不管
  if (after.length - tail !== head) return null
  const from = head
  const to = before.length - tail
  let start = from
  let end = to
  for (const range of ranges) {
    if (range.start < to && range.end > from) {
      start = Math.min(start, range.start)
      end = Math.max(end, range.end)
    }
  }
  if (start === from && end === to) return null
  return { text: before.slice(0, start) + before.slice(end), caret: start }
}

/** 选中的那段文字里整个包住的片（复制、剪切时随文字带上是哪个会话） */
export function chipsWithin(
  ranges: readonly MentionRange[],
  start: number,
  end: number,
): DraftMention[] {
  return ranges
    .filter((range) => range.start >= start && range.end <= end)
    .map(({ threadId, title }) => ({ threadId, title }))
}

/** 剪贴板里随文字带的会话：只认同一台设备上的 */
export const CLIPBOARD_TYPE = 'application/x-litch-session-mentions'

export function clipboardMentions(raw: string, deviceId: string): DraftMention[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return []
    const { device, mentions } = parsed as { device?: unknown; mentions?: unknown }
    if (device !== deviceId || !Array.isArray(mentions)) return []
    return mentions.flatMap((one): DraftMention[] =>
      one && typeof one.threadId === 'string' && typeof one.title === 'string'
        ? [{ threadId: one.threadId, title: one.title }]
        : [],
    )
  } catch {
    return []
  }
}
