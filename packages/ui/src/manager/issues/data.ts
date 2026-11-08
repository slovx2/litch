// 经理 issue 的数据入口：界面只经这里读 issue 视图、发 issue 命令。
// 【桩】核心还没有 issue 的订阅与命令（M1 补），这里先接 core 里的内存桩（manager-issues-stub.mts）：
// 只在浏览器里的模拟核心启用，Electron 里 supported=false，控制台照旧是四类。
// M1 接上后把 useManagerIssues 换成 useKey(keys.managerIssues(...))、issueCommands 换成 channel.command(...)，
// 组件不用改。预览可用 window.__litchIssues.scene('empty' | 'many' | 'old' | 'forbidden' | 'default') 切场景。
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  createManagerIssueStub,
  type ManagerIssueStubScene,
  type ManagerIssuesView,
} from '../../../../core/src/manager-issues-stub.mts'
import type { ManagerBoardView, ManagerView } from '../../../../core/src/model-manager.mts'
import type { ManagerIssueFilter } from '../../../../core/src/projection/manager-issue-list.mts'
import type {
  ManagerIssueFollowUp,
  ManagerOrdinaryStatus,
} from '../../../../protocol/src/manager-issues.mts'

declare global {
  interface Window {
    __litchIssues?: { scene(name: ManagerIssueStubScene): void }
  }
}

const lang = () => (document.documentElement.lang === 'en' ? 'en' : 'zh-CN')
const stub = createManagerIssueStub({
  now: () => Date.now(),
  lang,
  later: (run) => window.setTimeout(run, 2500),
})
stub.configure({ enabled: typeof window !== 'undefined' && !window.litchShell })
if (typeof window !== 'undefined')
  window.__litchIssues = { scene: (name) => stub.configure({ scene: name }) }

/** 看板到了以后才有 issue 视图；board 用来投影特殊 issue（桩专用，真实核心不需要）。 */
export function useManagerIssues(
  manager: Pick<ManagerView, 'deviceId' | 'id'>,
  board: ManagerBoardView | null,
): ManagerIssuesView {
  const { deviceId, id } = manager
  useEffect(() => {
    if (board) stub.syncBoard(deviceId, id, board)
  }, [deviceId, id, board])
  return useSyncExternalStore(stub.subscribe, () => stub.view(deviceId, id))
}

export interface IssueCommands {
  list(filter: ManagerIssueFilter, more?: boolean): Promise<void>
  read(id: string): Promise<unknown>
  create(params: { title: string; body: string; followUp?: ManagerIssueFollowUp }): Promise<{
    issue: { id: string }
  }>
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
