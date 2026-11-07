import { type ChannelError, keys, type ManagerBoardPages } from '@litch/core'
import { createContext, useContext, useEffect } from 'react'
import type {
  ManagerBoardTopicView,
  ManagerFeaturesView,
  ManagerView,
} from '../../../core/src/model-manager.mts'
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

/**
 * 设备宣告了哪些后加的经理能力（看板视图带的 features）。没宣告的是比应用旧的设备服务：
 * 入口禁用、写明去设备详情升级，不等点了再报错。没包在控制台里的地方按都有算。
 */
export const ManagerFeaturesContext = createContext<ManagerFeaturesView>({
  feedback: true,
  requestIgnore: true,
  posts: true,
  ignore: true,
})
export const useManagerFeatures = () => useContext(ManagerFeaturesContext)
