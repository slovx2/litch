// 用户关注的对象统一投影为帖子；原决策、请求与提案仍是各自行为的权威。
import type { ManagerDiscussion } from './manager.mjs'
export const MANAGER_NAMES = {
  work: { 'zh-CN': '经理事项', en: 'Manager items' },
  inbox: { 'zh-CN': '控制台', en: 'Console' },
} as const
export type ManagerPostId = `D-${number}` | `R-${number}` | `P-${number}` | `S-${string}`
export type ManagerPostKind = 'decision' | 'request' | 'report' | 'suggestion'
export interface ManagerReport {
  id: `P-${number}`
  title: string
  body: string
  revision: number
  readRevision: number
  createdAt: number
  updatedAt: number
}
export interface ManagerPostVersion {
  revision: number
  title: string
  body: string
  at: number
  by: string
  why: string
}
export interface ManagerPost {
  id: ManagerPostId
  kind: ManagerPostKind
  /** 预留用户新建议题；本版只由经理发布。 */
  author?: { kind: 'manager' | 'user'; name?: string }
  title: string
  body: string
  revision: number
  createdAt: number
  updatedAt: number
  discussion: ManagerDiscussion
  versions: ManagerPostVersion[]
  unread?: boolean
  proposalId?: string
  sourceThreadId?: string
  /** 当前字段供经理定向修改，不能借此写入运行状态或用户答复。 */
  fields: Record<string, unknown>
}
export interface ManagerPostQuestionParams {
  managerId: string
  id: ManagerPostId
  revision: number
  question: string
  mode: 'manager' | 'temporary'
}
export interface ManagerReportReadParams {
  managerId: string
  id: `P-${number}`
  revision: number
}
export interface ManagerPostPatch {
  title?: string
  body?: string
  options?: { id: string; label: string; description: string }[]
  recommend?: string | null
  buttonLabel?: string | null
}
export const MANAGER_POST_METHOD = {
  question: 'litch/manager/post/question',
  read: 'litch/manager/report/read',
  forward: 'litch/manager/post/forward',
  reference: 'litch/manager/reference/read',
} as const

export interface ManagerRelationTarget {
  kind: 'issue' | 'item' | 'thread' | 'file' | 'branch' | 'commit' | 'url'
  target: string
  label?: string
}
export interface ManagerRelation {
  id: string
  from: ManagerRelationTarget
  to: ManagerRelationTarget
  kind: 'derived' | 'related'
  at: number
  by: 'manager' | 'user' | 'question' | 'projection'
}
