// 手机上经理 issue 的数据入口：组件只经这里读 issue 视图、发 issue 命令，与桌面 packages/ui/src/manager/issues/data.ts 对应。
// 【桩】核心还没有 issue 的订阅与命令（M1 补），先接 core 里的内存桩；M1 接上后换成 useKey + channel.command，组件不用改。
import type { ManagerBoardView, ManagerView } from '@litch/core'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  createManagerIssueStub,
  type ManagerIssuesView,
} from '../../../../../../packages/core/src/manager-issues-stub.mts'
import type { ManagerIssueFilter } from '../../../../../../packages/core/src/projection/manager-issue-list.mts'
import type {
  ManagerIssueFollowUp,
  ManagerOrdinaryStatus,
} from '../../../../../../packages/protocol/src/manager-issues.mts'
import { ISSUE_STUB_ENABLED, ISSUE_STUB_SCENE } from './stub-enabled'

let lang: 'zh-CN' | 'en' = 'zh-CN'
const stub = createManagerIssueStub({
  now: () => Date.now(),
  lang: () => lang,
  later: (run) => setTimeout(run, 2500),
})
stub.configure({ enabled: ISSUE_STUB_ENABLED, scene: ISSUE_STUB_SCENE })

export function useManagerIssues(
  manager: Pick<ManagerView, 'deviceId' | 'id'>,
  board: ManagerBoardView | null,
  language: 'zh-CN' | 'en',
): ManagerIssuesView {
  lang = language
  const { deviceId, id } = manager
  useEffect(() => {
    if (board) stub.syncBoard(deviceId, id, board)
  }, [deviceId, id, board])
  return useSyncExternalStore(stub.subscribe, () => stub.view(deviceId, id))
}

export interface IssueCommands {
  list(filter: ManagerIssueFilter, more?: boolean): Promise<void>
  read(id: string): Promise<unknown>
  create(params: {
    title: string
    body: string
    followUp?: ManagerIssueFollowUp
  }): Promise<{ issue: { id: string } }>
  update(params: {
    id: string
    revision: number
    patch: { title?: string; body?: string; status?: ManagerOrdinaryStatus }
  }): Promise<unknown>
  comment(params: { id: string; revision: number; body: string }): Promise<unknown>
  follow(params: { id: string; revision: number; state: ManagerIssueFollowUp }): Promise<unknown>
  seen(params: { id: string; revision: number }): Promise<unknown>
}

export function useIssueCommands(manager: Pick<ManagerView, 'deviceId' | 'id'>): IssueCommands {
  const { deviceId, id: managerId } = manager
  return useMemo(
    () => ({
      list: (filter, more) => stub.list(deviceId, managerId, filter, more),
      read: (id) => stub.read(deviceId, managerId, id),
      create: (params) => stub.create(deviceId, managerId, params),
      update: (params) => stub.update(deviceId, managerId, params),
      comment: (params) => stub.comment(deviceId, managerId, params),
      follow: (params) => stub.follow(deviceId, managerId, params),
      seen: (params) => stub.seen(deviceId, managerId, params),
    }),
    [deviceId, managerId],
  )
}
