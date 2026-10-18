// 会话列表的合并。
// 各引擎的排序键和翻页游标互不相同，所以聚合面只支持一种排序：按更新时间倒序。
// 做法是多路归并：每个上游各取一页，每次从各路的队头里挑更新时间最新的一个给出去，
// 哪一路的这一页给完了再向它要下一页。翻页游标是把各上游的游标打包在一起的不透明字符串。
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import { isObject } from './wire.mjs'

export interface ListPage {
  data: unknown[]
  nextCursor: string | null
}

export interface ListSource {
  harness: string
  fetch(params: Record<string, unknown>): Promise<ListPage>
}

/**
 * 游标里一个上游的状态。上游的游标只能指到“它某一页的末尾”，而归并常常停在一页的中间，
 * 所以除了交给上游的游标 c，还要记下那一页里已经给出去的最后一个会话（标识 a、更新时间 t），
 * 下次用 c 把那一页重新取回来，跳到 a 之后接着给。
 */
interface SourceCursor {
  c: string | null
  a?: string
  t?: number
}

interface PackedCursor {
  v: 1
  /** 向上游取每一页的大小。一轮翻页里保持不变，位置才对得上 */
  n: number
  /** 键是 harness。null 表示这个上游已经取完；不在里面的上游不参加这一轮翻页 */
  s: Record<string, SourceCursor | null>
}

export function packCursor(cursor: PackedCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

export function unpackCursor(text: string): PackedCursor {
  try {
    const value: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'))
    if (!isObject(value) || value.v !== 1 || !isObject(value.s)) throw new Error('形状不对')
    if (typeof value.n !== 'number' || !Number.isInteger(value.n) || value.n < 1)
      throw new Error('页大小不对')
    const sources: Record<string, SourceCursor | null> = {}
    for (const [harness, state] of Object.entries(value.s)) {
      if (state === null) {
        sources[harness] = null
        continue
      }
      if (!isObject(state) || (state.c !== null && typeof state.c !== 'string'))
        throw new Error('上游游标不对')
      sources[harness] =
        typeof state.a === 'string' && typeof state.t === 'number'
          ? { c: state.c, a: state.a, t: state.t }
          : { c: state.c }
    }
    return { v: 1, n: value.n, s: sources }
  } catch {
    throw new ProtocolError(-32602, '会话游标无效：只能原样使用聚合面上一次给的 nextCursor')
  }
}

export type Row = Record<string, unknown> & { id: string }

interface Mark {
  a: string
  t: number
}

interface Lane {
  source: ListSource
  /** 取回来还没给出去的 */
  items: Row[]
  /** items 所在的那一页是用哪个游标取的 */
  pageCursor: string | null
  /** 取下一页要用的游标 */
  next: string | null
  /** 后面还有没有页 */
  more: boolean
  /** 当前这一页里已经给到哪了 */
  mark: Mark | null
  /** 游标带回来的位置还没在取回来的页里找到 */
  seeking: boolean
  failed: string | null
}

const time = (row: Row): number => {
  const value = Number(row.updatedAt)
  return Number.isFinite(value) ? value : 0
}

/**
 * 在重新取回来的一页里找到上次停下的位置，返回它之后的部分。
 * 那个会话还在原处：从它后面接着给。不在了（被删了，或者更新过排到前面去了）：
 * 按更新时间接，比它新的都算给过了。同一秒更新的可能重复给一次，客户端按标识去重；宁可重复，不能漏。
 */
function skipTo(items: Row[], mark: Mark): { items: Row[]; found: boolean } {
  const index = items.findIndex((row) => row.id === mark.a && time(row) === mark.t)
  if (index >= 0) return { items: items.slice(index + 1), found: true }
  const rest = items.filter((row) => time(row) <= mark.t && row.id !== mark.a)
  // 整页都比停下的位置新：位置还在后面的页里
  return { items: rest, found: rest.length > 0 || items.length === 0 }
}

export interface MergeInput {
  sources: ListSource[]
  limit: number
  cursor: string | null
  /** 原样交给每个上游的筛选条件（不含游标、页大小、排序） */
  filters: Record<string, unknown>
  /**
   * 上游筛不了、要在这里筛的条件（会话的工作区、分区存在设备层）。不要的会话照样算“看过了”：
   * 翻页的位置记的是各上游读到哪了，不是给出去了几个，所以筛掉多少都不漏不重。
   * 代价是要的会话很少时，凑满一页得往后读很多页，最坏读到各上游的尽头。
   */
  accept?(row: Row): boolean
}

export interface MergeResult {
  /** 已经打上 harness 的会话对象 */
  data: Row[]
  nextCursor: string | null
  /** 问了但没有成的上游 */
  failed: { harness: string; message: string }[]
  /** 这一轮翻页从一开始就没有包含的上游 */
  excluded: string[]
}

export async function mergeThreadList(input: MergeInput): Promise<MergeResult> {
  const packed = input.cursor === null ? null : unpackCursor(input.cursor)
  const pageSize = packed?.n ?? input.limit
  const lanes: Lane[] = []
  const excluded: string[] = []
  for (const source of input.sources) {
    const state = packed ? packed.s[source.harness] : { c: null }
    if (state === undefined) {
      excluded.push(source.harness)
      continue
    }
    const mark = state?.a !== undefined && state.t !== undefined ? { a: state.a, t: state.t } : null
    lanes.push({
      source,
      items: [],
      pageCursor: null,
      next: state?.c ?? null,
      more: state !== null,
      mark,
      seeking: mark !== null,
      failed: null,
    })
  }

  const fill = async (lane: Lane): Promise<void> => {
    while (lane.items.length === 0 && lane.more && lane.failed === null) {
      const used = lane.next
      let page: ListPage
      try {
        page = await lane.source.fetch({
          ...input.filters,
          limit: pageSize,
          sortKey: 'updated_at',
          sortDirection: 'desc',
          ...(used === null ? {} : { cursor: used }),
        })
      } catch (error) {
        lane.failed = error instanceof Error ? error.message : String(error)
        return
      }
      let items = page.data.filter((row): row is Row => isObject(row) && typeof row.id === 'string')
      if (lane.seeking && lane.mark) {
        const skipped = skipTo(items, lane.mark)
        items = skipped.items
        lane.seeking = !skipped.found
      } else lane.mark = null
      lane.items = items
      lane.pageCursor = used
      lane.next = page.nextCursor
      // 空页还带着下一页的游标不合常理，当作到头了，免得在一个出错的上游上转圈
      lane.more = page.nextCursor !== null && page.data.length > 0
    }
  }

  await Promise.all(lanes.map(fill))
  const data: Row[] = []
  while (data.length < input.limit) {
    let best: Lane | null = null
    for (const lane of lanes) {
      const head = lane.items[0]
      const lead = best?.items[0]
      if (head && lane.failed === null && (!lead || time(head) > time(lead))) best = lane
    }
    const row = best?.items.shift()
    if (!best || !row) break
    best.mark = { a: row.id, t: time(row) }
    if (!input.accept || input.accept(row)) {
      row.harness = best.source.harness
      data.push(row)
    }
    if (best.items.length === 0 && data.length < input.limit) await fill(best)
  }

  const states: Record<string, SourceCursor | null> = {}
  let unfinished = false
  for (const lane of lanes) {
    if (lane.failed !== null) continue
    if (lane.items.length > 0) {
      states[lane.source.harness] = { c: lane.pageCursor, ...(lane.mark ?? {}) }
      unfinished = true
    } else if (lane.more) {
      // 这一页正好给完，下次直接从上游的下一页开始
      states[lane.source.harness] = { c: lane.next }
      unfinished = true
    } else states[lane.source.harness] = null
  }
  return {
    data,
    nextCursor: unfinished ? packCursor({ v: 1, n: pageSize, s: states }) : null,
    failed: lanes.flatMap((lane) =>
      lane.failed === null ? [] : [{ harness: lane.source.harness, message: lane.failed }],
    ),
    excluded,
  }
}
