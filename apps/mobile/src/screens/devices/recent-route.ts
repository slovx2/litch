import type { SidebarProjectionRow } from '@litch/core'
import type { RootStackParamList } from '../../nav/routes'

/** 最近组只传会话标识；SessionScreen 与其他入口共用经理工作台分流。 */
export function recentRoute(
  row: SidebarProjectionRow,
  title: string,
): ['Detail', RootStackParamList['Detail']] {
  return ['Detail', { deviceId: row.deviceId, sessionId: row.sessionId, title }]
}
