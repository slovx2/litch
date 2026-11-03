// 分页扩展独立于完整 board/read；时间为 Unix 秒。只按声明了 litchManagerPaging 的连接提供。
import type {
  Manager,
  ManagerActivity,
  ManagerChange,
  ManagerClosed,
  ManagerDecision,
  ManagerItem,
  ManagerLine,
  ManagerObjectId,
  ManagerRequest,
  ManagerSituation,
} from './manager.mjs'
import type { ManagerPost, ManagerRelation } from './manager-posts.mjs'

export const MANAGER_PAGING_METHOD = {
  catalog: 'litch/manager/catalog/read',
  summary: 'litch/manager/board/summary',
  page: 'litch/manager/objects/list',
  detail: 'litch/manager/object/read',
  history: 'litch/manager/object/history',
  lines: 'litch/manager/lines/read',
} as const
export const MANAGER_PAGE_SIZE = 30
export type ManagerPageKind = 'decision' | 'request' | 'suggestion' | 'report' | 'item'
export type ManagerPageOrder = 'newest' | 'oldest' | 'pending'
export interface ManagerPageQuery {
  kind: ManagerPageKind
  /** all、pending，或该种类的状态；决策另有合并 expired/withdrawn 的 closed。 */
  status: string
  order: ManagerPageOrder
}
export interface ManagerPageParams extends ManagerPageQuery {
  managerId: string
  cursor?: string
  /** 默认 30，最大 100。 */
  limit?: number
}
export interface ManagerObjectHead {
  id: ManagerObjectId
  kind: ManagerPageKind
  title: string
  /** 至多 160 字符的正文预览；不携带完整正文、选项、依据、讨论和历史。 */
  preview: string
  status: string
  pending: boolean
  revision: number
  createdAt: number
  updatedAt: number
}
export interface ManagerObjectPage {
  query: ManagerPageQuery
  entries: ManagerObjectHead[]
  /** 此游标的创建上界内、当前筛选命中的总数。对象状态可能并发改变。 */
  total: number
  nextCursor: string | null
}
export type ManagerBoardCounts = Record<ManagerPageKind, Record<string, number>>
export interface ManagerLineHead extends Omit<ManagerLine, 'report' | 'unverified'> {
  reportPreview: string | null
  unverifiedCount: number
  /** null 表示尚未向引擎核对；不能把未核对的 idle 当成已确认空闲。 */
  checkedAt: number | null
}
export interface ManagerLinesPage {
  lines: ManagerLineHead[]
  checkedAt: number | null
  failed: number
}
export interface ManagerBoardSummary {
  manager: Manager
  situation: ManagerSituation | null
  counts: ManagerBoardCounts
  initial: ManagerObjectPage
  activities: ManagerActivity[]
  lines: ManagerLinesPage
}
export interface ManagerObjectDetail {
  object: ManagerDecision | ManagerRequest | ManagerItem | null
  post: ManagerPost | null
  relations: ManagerRelation[]
  previousClosed: ManagerClosed | null
  reopened: ManagerClosed | null
}
export interface ManagerHistoryParams {
  managerId: string
  id: ManagerObjectId
  cursor?: string
  limit?: number
}
export interface ManagerHistoryPage {
  changes: ManagerChange[]
  nextCursor: string | null
}
export interface ManagerPagingRequests {
  'litch/manager/catalog/read': { params: Record<string, never>; result: { managers: Manager[] } }
  'litch/manager/board/summary': {
    params: { managerId: string }
    result: { summary: ManagerBoardSummary }
  }
  'litch/manager/objects/list': { params: ManagerPageParams; result: ManagerObjectPage }
  'litch/manager/object/read': {
    params: { managerId: string; id: ManagerObjectId }
    result: ManagerObjectDetail
  }
  'litch/manager/object/history': { params: ManagerHistoryParams; result: ManagerHistoryPage }
  'litch/manager/lines/read': {
    params: { managerId: string; refresh?: boolean }
    result: ManagerLinesPage
  }
}
