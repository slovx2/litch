import type { ItemView, SessionSummary } from '../model.mjs'
import type { SearchRange } from './text.mjs'

/** 第一期开在当前可用的会话投影上；不表示引擎提供了全部原生历史。 */
export interface SearchSource {
  turnId: string
  item: ItemView
}
export interface SearchHit extends SearchRange {
  turnId: string
  itemId: string
  ordinal: number
}
export interface SearchResult {
  hits: SearchHit[]
  count: number
  query: string
  revision: number
  /** 按对话顺序排列的结果中，离查询起点最近的一处。 */
  nearest?: number
}
export interface TitleHit {
  session: SessionSummary
  archived: boolean
}
export interface TitleSearchResult {
  hits: TitleHit[]
  hasMore: boolean
  online: boolean
  /** 目录枚举已结束、未截断且所有入口均成功；离线快照不是完整的新目录。 */
  complete: boolean
  archivedLoaded: boolean
  missingHarnesses: string[]
}
export type SearchWorkerInput =
  | { type: 'reset' }
  | { type: 'update'; sources: SearchSource[]; removed: string[] }
  | {
      type: 'query'
      query: string
      revision: number
      order: string[]
      anchor?: { itemId: string; start: number }
    }
/** Worker 加载完先报 ready，之后只回查询结果；主线程据此判断加载是否卡住。 */
export type SearchWorkerOutput = { type: 'ready' } | SearchResult
