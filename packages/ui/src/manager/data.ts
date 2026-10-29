import { type ChannelError, keys, type ManagerBoardPages } from '@litch/core'
import { useEffect } from 'react'
import type { ManagerBoardTopicView, ManagerView } from '../../../core/src/model-manager.mts'
import { useKey, useKeys, useServices } from '../app/services.tsx'
import { useDevices } from '../composer/useNewPlace.ts'

/** 经理目录由副本常驻订阅；界面只读取自己显示的键。 */
export function useManagers() {
  const devices = useDevices()
  const ids = useKeys<string[]>(devices.map((device) => keys.managerIds(device.id)))
  const managers = useKeys<ManagerView>(
    devices.flatMap((device, index) => (ids[index] ?? []).map((id) => keys.manager(device.id, id))),
  ).filter((manager) => manager !== undefined)
  const available = useKeys<boolean | null>(
    devices.map((device) => keys.managersAvailable(device.id)),
  )
  return {
    devices,
    managers,
    available: devices.filter(
      (device, index) => device.connection === 'online' && available[index] === true,
    ),
  }
}

export function useManagerBoard(manager: ManagerView) {
  const { replica } = useServices()
  const { deviceId, id: managerId } = manager
  useEffect(() => replica.openManagerBoard(deviceId, managerId), [replica, deviceId, managerId])
  const view = useKey<ManagerBoardTopicView>(keys.managerBoard(deviceId, managerId))
  const pages = useKey<ManagerBoardPages | null>(keys.managerBoardPages(deviceId, managerId))
  const error = useKey<ChannelError>(keys.managerBoardError(deviceId, managerId))
  return { view, pages, error }
}
