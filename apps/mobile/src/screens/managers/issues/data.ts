// 手机上经理 issue 的数据入口：组件只经这里读 issue 视图、发 issue 命令，与桌面 packages/ui/src/manager/issues/data.ts 对应。
// 视图是经理看板订阅里的 issues（核心缓存，时间是毫秒）；命令走 managers.issues.list 与 managers.issue.*。
import {
  type ManagerBoardTopicView,
  type ManagerIssueFollowUp,
  type ManagerIssueId,
  type ManagerIssuesView,
  type ManagerOrdinaryStatus,
  type ManagerView,
  managerIssueQueryKey,
} from '@litch/core'
import { useEffect, useMemo } from 'react'
import {
  type ManagerIssueFilter,
  managerIssueQuery,
} from '../../../../../../packages/core/src/projection/manager-issue-list.mts'
import { useChannel } from '../../../shell/services'

export interface ManagerIssuesState extends ManagerIssuesView {
  /** true：设备支持 issue；false：设备服务旧，控制台照旧是四类；null：看板还没到 */
  supported: boolean | null
  discussions?: boolean
}

const EMPTY: ManagerIssuesView = { pages: {}, details: {}, loading: [], error: null }

export function useManagerIssues(
  view: ManagerBoardTopicView | null | undefined,
): ManagerIssuesState {
  return useMemo(
    () => ({
      ...(view?.issues ?? EMPTY),
      supported: view ? view.features.issues === true : null,
      discussions: view?.features.issueDiscussions === true,
    }),
    [view],
  )
}

export interface IssueCommands {
  canOpenDiscussion?: boolean
  /** 列一页；cursor 是上一页的 nextCursor（加载更多）；limit 给计数用的一行查询 */
  list(
    filter: ManagerIssueFilter,
    options?: { cursor?: string; limit?: number; manual?: boolean },
  ): Promise<void>
  read(id: string, options?: { manual?: boolean }): Promise<unknown>
  create(params: {
    title: string
    body: string
    followUp?: ManagerIssueFollowUp
  }): Promise<{ issue: { id: string } }>
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

/** 提交标识：重发同一次新建或评论时设备认得出来 */
const once = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

export function useIssueCommands(
  manager: Pick<ManagerView, 'deviceId' | 'id'>,
  discussions = false,
): IssueCommands {
  const channel = useChannel()
  const { deviceId, id: managerId } = manager
  return useMemo(() => {
    const ref = (id: string) => id as ManagerIssueId
    return {
      canOpenDiscussion: discussions,
      list: async (filter, options = {}) => {
        await channel.command('managers.issues.list', {
          deviceId,
          ...managerIssueQuery(managerId, filter, options.limit),
          ...(options.cursor ? { cursor: options.cursor } : {}),
          ...(options.manual ? { manual: true } : {}),
        })
      },
      read: (id, options) =>
        channel.command('managers.issue.read', {
          deviceId,
          managerId,
          id: ref(id),
          ...(options?.manual ? { manual: true } : {}),
        }),
      create: (params) =>
        channel.command('managers.issue.create', {
          deviceId,
          managerId,
          ...params,
          idempotencyKey: once(),
        }),
      update: ({ id, ...rest }) =>
        channel.command('managers.issue.update', { deviceId, managerId, id: ref(id), ...rest }),
      comment: ({ id, ...rest }) =>
        channel.command('managers.issue.comment', {
          deviceId,
          managerId,
          id: ref(id),
          ...rest,
          idempotencyKey: once(),
        }),
      follow: ({ id, ...rest }) =>
        channel.command('managers.issue.follow', { deviceId, managerId, id: ref(id), ...rest }),
      seen: ({ id, ...rest }) =>
        channel.command('managers.issue.seen', { deviceId, managerId, id: ref(id), ...rest }),
    }
  }, [channel, deviceId, managerId, discussions])
}

/** 几组条件各自的总数：每组一条只取一行的查询，读那一页的 total；还没回来是 null。 */
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
