// 新建对话页现在指着哪台设备、哪个工作区：明说了的照它来，没说的按默认的来。
// 怎么定默认在 new-place.ts，上次用的是哪里记在 remembered.ts；这里只是把状态库里的设备和工作区接上去。
import { type DeviceView, keys, type WorkspaceView } from '@litch/core'
import { useKey, useKeys } from '../app/services.tsx'
import { type Place, type PlaceWish, resolvePlace } from './new-place.ts'
import { recallDevice, recallWorkspace } from './remembered.ts'

const NO_DEVICES: readonly string[] = []

/** 现在有的设备，按添加的顺序。视图还没到的那几台不在里面 */
export function useDevices(): DeviceView[] {
  const deviceIds = useKey<string[]>(keys.devices) ?? NO_DEVICES
  const views = useKeys<DeviceView>(deviceIds.map(keys.device))
  return views.filter((view) => view !== undefined)
}

/** wish：在页上明说的去处，没有就是 null。一台设备都没有时返回 null */
export function useNewPlace(wish: PlaceWish | null): Place | null {
  const devices = useDevices()
  const workspaces = useKeys<WorkspaceView[]>(devices.map((device) => keys.workspaces(device.id)))
  return resolvePlace(wish, {
    devices,
    workspaces: (deviceId) => workspaces[devices.findIndex((device) => device.id === deviceId)],
    lastDevice: recallDevice(),
    lastWorkspace: recallWorkspace,
  })
}
