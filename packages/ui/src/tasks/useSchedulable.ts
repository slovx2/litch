// 现在能在上面建定时任务的设备：连着，上面的服务也支持定时任务（设备信息里列了 deviceTasks）。
import { type DeviceView, keys } from '@litch/core'
import { useKeys } from '../app/services.tsx'
import { useDevices } from '../composer/useNewPlace.ts'

export function useSchedulable(): DeviceView[] {
  const devices = useDevices()
  const available = useKeys<boolean | null>(devices.map((device) => keys.tasksAvailable(device.id)))
  return devices.filter(
    (device, index) => device.connection === 'online' && available[index] === true,
  )
}
