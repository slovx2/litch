// 经理 issue 的数据入口：界面只经这里读 issue 视图、发 issue 命令。
// 视图是经理看板订阅里的 issues（核心缓存，时间是毫秒），页按 managerIssueQueryKey(query) 分，加载更多并进同一页；
// 命令走 managers.issues.list 与 managers.issue.*，改动后核心自己重读已订阅的页和详情。
import { useEffect, useMemo } from 'react'
import type { ManagerBoardTopicView, ManagerView } from '../../../../core/src/model-manager.mts'
import {
  type ManagerIssuesView,
  managerIssueQueryKey,
} from '../../../../core/src/model-manager-issues.mts'
import {
  type ManagerIssueFilter,
  managerIssueQuery,
} from '../../../../core/src/projection/manager-issue-list.mts'
import type {
  ManagerIssueFollowUp,
  ManagerIssueId,
  ManagerOrdinaryStatus,
} from '../../../../protocol/src/manager-issues.mts'
import { useServices } from '../../app/services.tsx'

export interface ManagerIssuesState extends ManagerIssuesView {
  /** true：设备支持 issue；false：设备服务旧，控制台照旧是四类；null：看板还没到 */
  supported: boolean | null
}

const EMPTY: ManagerIssuesView = { pages: {}, details: {}, loading: [], error: null }

export function useManagerIssues(
  view: ManagerBoardTopicView | null | undefined,
): ManagerIssuesState {
  return useMemo(
    () => ({
      ...(view?.issues ?? EMPTY),
      supported: view ? view.features.issues === true : null,
    }),
    [view],
  )
}

export interface IssueCommands {
  /** 列一页；cursor 是上一页的 nextCursor（加载更多）；limit 给计数用的一行查询 */
  list(filter: ManagerIssueFilter, options?: { cursor?: string; limit?: number }): Promise<void>
  read(id: string): Promise<unknown>
  create(params: { title: string; body: string; followUp?: ManagerIssueFollowUp }): Promise<{
    issue: { id: string }
  }>
  update(params: {
    id: string
    revision: number
    patch: {
      title?: string
      body?: string
      status?: ManagerOrdinaryStatus
      discussionOpened?: true
    }
    why: string
  }): Promise<unknown>
  comment(params: { id: string; revision: number; body: string }): Promise<unknown>
  follow(params: {
    id: string
    revision: number
    state: ManagerIssueFollowUp
    why: string
  }): Promise<unknown>
  seen(params: { id: string; revision: number }): Promise<unknown>
}

export function useIssueCommands(manager: Pick<ManagerView, 'deviceId' | 'id'>): IssueCommands {
  const { channel } = useServices()
  const { deviceId, id: managerId } = manager
  return useMemo(() => {
    const ref = (id: string) => id as ManagerIssueId
    return {
      list: async (filter, options = {}) => {
        await channel.command('managers.issues.list', {
          deviceId,
          ...managerIssueQuery(managerId, filter, options.limit),
          ...(options.cursor ? { cursor: options.cursor } : {}),
        })
      },
      read: (id) => channel.command('managers.issue.read', { deviceId, managerId, id: ref(id) }),
      create: (params) =>
        channel.command('managers.issue.create', {
          deviceId,
          managerId,
          ...params,
          idempotencyKey: crypto.randomUUID(),
        }),
      update: ({ id, ...rest }) =>
        channel.command('managers.issue.update', { deviceId, managerId, id: ref(id), ...rest }),
      comment: ({ id, ...rest }) =>
        channel.command('managers.issue.comment', {
          deviceId,
          managerId,
          id: ref(id),
          ...rest,
          idempotencyKey: crypto.randomUUID(),
        }),
      follow: ({ id, ...rest }) =>
        channel.command('managers.issue.follow', { deviceId, managerId, id: ref(id), ...rest }),
      seen: ({ id, ...rest }) =>
        channel.command('managers.issue.seen', { deviceId, managerId, id: ref(id), ...rest }),
    }
  }, [channel, deviceId, managerId])
}

/**
 * 几组条件各自的总数（概览三个数、类别胶囊上的数字）：每组发一条只取一行的查询，读那一页的 total。
 * 核心记着这些查询，issue 有变化时一起重读，数字跟着变。还没回来时是 null。
 */
export function useIssueCounts<K extends string>(
  manager: Pick<ManagerView, 'deviceId' | 'id'>,
  issues: ManagerIssuesState,
  filters: Record<K, ManagerIssueFilter>,
): Record<K, number | null> | null {
  const commands = useIssueCommands(manager)
  const { supported } = issues
  useEffect(() => {
    if (!supported) return
    for (const filter of new Set(Object.values<ManagerIssueFilter>(filters)))
      void commands.list(filter, { limit: 1 }).catch(() => {})
  }, [supported, commands, filters])
  if (!supported) return null
  return Object.fromEntries(
    Object.entries<ManagerIssueFilter>(filters).map(([key, filter]) => [
      key,
      issues.pages[managerIssueQueryKey(managerIssueQuery(manager.id, filter, 1))]?.total ?? null,
    ]),
  ) as Record<K, number | null>
}
