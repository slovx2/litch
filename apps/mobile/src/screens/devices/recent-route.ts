import type { SidebarProjectionRow } from '@litch/core'
import type { RootStackParamList } from '../../nav/routes'

/** 最近组是会话入口；经理也直接打开对话，经理控制台保留独立入口。 */
export function recentRoute(
  row: SidebarProjectionRow,
  title: string,
): ['Detail', RootStackParamList['Detail']] {
  return ['Detail', { deviceId: row.deviceId, sessionId: row.sessionId, title }]
}
