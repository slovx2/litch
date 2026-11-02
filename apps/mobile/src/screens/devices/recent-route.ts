import { managerMark, type SessionSummary, type SidebarProjectionRow } from '@litch/core'
import type { RootStackParamList } from '../../nav/routes'

/** 最近组只投影主项；经理入口进经理页，普通会话仍进对话详情。 */
export function recentRoute(
  row: SidebarProjectionRow,
  summary: SessionSummary | undefined,
  title: string,
):
  | ['ManagerConsole', RootStackParamList['ManagerConsole']]
  | ['Detail', RootStackParamList['Detail']] {
  const mark = summary ? managerMark(summary) : null
  return mark?.role === 'manager'
    ? ['ManagerConsole', { deviceId: row.deviceId, managerId: mark.managerId }]
    : ['Detail', { deviceId: row.deviceId, sessionId: row.sessionId, title }]
}
