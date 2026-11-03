import type { SessionDestination } from '@litch/core'
import type { RootStackParamList } from './routes'

/** 未确认时不进入详情；确认后只生成正式目的页的参数，不留下中转栈。 */
export function resolvedSessionRoute(
  params: RootStackParamList['Detail'],
  destination: SessionDestination,
):
  | ['Detail', RootStackParamList['Detail']]
  | ['ManagerConsole', RootStackParamList['ManagerConsole']]
  | undefined {
  if (destination === undefined) return undefined
  if (destination === null) return ['Detail', params]
  return ['ManagerConsole', { deviceId: params.deviceId, managerId: destination }]
}
