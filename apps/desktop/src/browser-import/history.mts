// 读来源浏览器的浏览记录（管线自己读，不经读取器）：Chromium 系的 History，Firefox 的 places.sqlite。
// 库先拷进私有临时目录、只读打开（sqlite-copy.mts）；只取最近 90 天的访问，时间换成 Unix 毫秒。
// 子框架里的导航不算（Chromium 的 AUTO_SUBFRAME、MANUAL_SUBFRAME，Firefox 的 EMBED、FRAMED_LINK、DOWNLOAD）。
import { join } from 'node:path'
import type { HistoryVisit } from './sinks.mjs'
import { type CopyFailure, DatabaseCopyError, withDatabaseCopy } from './sqlite-copy.mjs'
import type { BrowserFamily } from './types.mjs'

export const HISTORY_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

/** Chromium 的时间是 1601-01-01 起的微秒；减去这个数（毫秒）就是 Unix 毫秒 */
const WEBKIT_EPOCH_OFFSET_MS = 11644473600000

const CHROMIUM_SQL = `
  SELECT u.url AS url, u.title AS title, (v.visit_time / 1000 - ${WEBKIT_EPOCH_OFFSET_MS}) AS at
  FROM visits v JOIN urls u ON u.id = v.url
  WHERE (v.visit_time / 1000 - ${WEBKIT_EPOCH_OFFSET_MS}) >= ? AND (v.transition & 255) NOT IN (3, 4)
  ORDER BY v.visit_time`

const FIREFOX_SQL = `
  SELECT p.url AS url, p.title AS title, (v.visit_date / 1000) AS at
  FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id
  WHERE (v.visit_date / 1000) >= ? AND v.visit_type NOT IN (4, 7, 8)
  ORDER BY v.visit_date`

export const historyFile = (family: BrowserFamily, profileDir: string): string =>
  join(profileDir, family === 'chromium' ? 'History' : 'places.sqlite')

export type HistoryReadResult =
  | { status: 'ok'; visits: HistoryVisit[] }
  | { status: CopyFailure; visits: []; error: string }

/** 最近 days 天里的访问，地址原样（不筛协议，由管线数“无效跳过”） */
export async function readHistory(
  family: BrowserFamily,
  profileDir: string,
  options: { now: number; signal: AbortSignal; days?: number },
): Promise<HistoryReadResult> {
  const since = options.now - (options.days ?? HISTORY_DAYS) * DAY_MS
  try {
    const visits = await withDatabaseCopy(historyFile(family, profileDir), options.signal, (db) => {
      const rows = db.prepare(family === 'chromium' ? CHROMIUM_SQL : FIREFOX_SQL).all(since)
      const visits: HistoryVisit[] = []
      for (const row of rows) {
        const url = row.url
        const at = Number(row.at)
        if (typeof url !== 'string' || !Number.isFinite(at)) continue
        visits.push({ url, title: typeof row.title === 'string' ? row.title : '', visitedAt: at })
      }
      return visits
    })
    return { status: 'ok', visits }
  } catch (error) {
    if (error instanceof DatabaseCopyError) {
      return { status: error.failure, visits: [], error: error.message }
    }
    return { status: 'failed', visits: [], error: 'cannot read history' }
  }
}
