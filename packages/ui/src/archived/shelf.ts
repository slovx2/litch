// 已归档对话页里不靠浏览器的那部分：按标题和项目名筛、按日期分组、记住上次看的设备。
import { type SessionSummary, searchQuery, searchText } from '@litch/core'
import { readRemembered, saveRemembered } from '../app/remembered.ts'

/** 一行要显示、要搜的东西：标题和项目名都已经是给人看的字。不属于哪个项目的 project 是 null */
export interface ShelfRow {
  session: SessionSummary
  title: string
  project: string | null
}

/** 每次多画这么多行，滚到底再接着画 */
export const SHELF_PAGE = 60

/** 时间倒序；同一时刻按标识排，顺序稳定 */
const newestFirst = (a: ShelfRow, b: ShelfRow) =>
  b.session.updatedAt - a.session.updatedAt || a.session.id.localeCompare(b.session.id)

/** 按标题或项目名筛（规范化后包含即可），空查询全留 */
export function matchShelf(rows: readonly ShelfRow[], query: string): ShelfRow[] {
  const wanted = searchQuery(query)
  const kept = wanted
    ? rows.filter(
        (row) =>
          searchText(row.title).includes(wanted) ||
          (row.project !== null && searchText(row.project).includes(wanted)),
      )
    : [...rows]
  return kept.sort(newestFirst)
}

/** 日期分组：今天、昨天、7 天内、30 天内，再早的按自然月 */
export type ShelfBucket =
  | { kind: 'today' | 'yesterday' | 'week' | 'month' }
  | { kind: 'calendar'; year: number; month: number }

export interface ShelfGroup {
  key: string
  bucket: ShelfBucket
  rows: ShelfRow[]
}

const DAY = 24 * 60 * 60 * 1000
const dayStart = (time: number) => {
  const date = new Date(time)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function bucketOf(time: number, now: number): ShelfBucket {
  // 两边时钟没对齐、落在将来的按今天算
  const days = Math.max(0, Math.round((dayStart(now) - dayStart(time)) / DAY))
  if (days === 0) return { kind: 'today' }
  if (days === 1) return { kind: 'yesterday' }
  if (days < 7) return { kind: 'week' }
  if (days < 30) return { kind: 'month' }
  const date = new Date(time)
  return { kind: 'calendar', year: date.getFullYear(), month: date.getMonth() + 1 }
}

const keyOf = (bucket: ShelfBucket) =>
  bucket.kind === 'calendar' ? `${bucket.year}-${bucket.month}` : bucket.kind

/** 已经按时间倒序的行，相邻同组的并在一起 */
export function groupShelf(rows: readonly ShelfRow[], now: number): ShelfGroup[] {
  const groups: ShelfGroup[] = []
  for (const row of rows) {
    const bucket = bucketOf(row.session.updatedAt, now)
    const key = keyOf(bucket)
    const last = groups.at(-1)
    if (last?.key === key) last.rows.push(row)
    else groups.push({ key, bucket, rows: [row] })
  }
  return groups
}

const STORE = 'litch.archived.device'

/** 上次在这一页看的是哪台设备 */
export function rememberedShelfDevice(): string | null {
  const value = readRemembered<string>(STORE).deviceId
  return typeof value === 'string' ? value : null
}

export function rememberShelfDevice(deviceId: string): void {
  saveRemembered(STORE, { deviceId })
}

/** 先看上次选的，再看当前对话所在的设备，都不在了取第一台 */
export function pickShelfDevice(
  ids: readonly string[],
  remembered: string | null,
  current: string | null,
): string | null {
  if (remembered && ids.includes(remembered)) return remembered
  if (current && ids.includes(current)) return current
  return ids[0] ?? null
}
