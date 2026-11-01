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
  | { type: 'query'; query: string; revision: number; order: string[] }
