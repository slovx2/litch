import { useEffect, useState } from 'react'
import type {
  ManagerBoardTopicView,
  ManagersView,
  ManagerView,
} from '../../../core/src/model-manager.mts'
import { useServices } from '../app/services.tsx'
import { useDevices } from '../composer/useNewPlace.ts'

/** 列表只订阅设备目录；看板由打开它的页面单独订阅。 */
export function useManagers() {
  const { channel } = useServices()
  const devices = useDevices()
  const ids = devices.map((device) => device.id).join('\n')
  const [views, setViews] = useState<Record<string, ManagersView>>({})
  useEffect(() => {
    const stops = (ids ? ids.split('\n') : []).map((deviceId) =>
      channel.subscribe(
        { kind: 'managers', deviceId },
        {
          snapshot: (view) => setViews((was) => ({ ...was, [deviceId]: view })),
          delta: (ops) =>
            setViews((was) => {
              const view = was[deviceId]
              if (!view) return was
              const managers = new Map(view.managers.map((manager) => [manager.id, manager]))
              for (const op of ops) managers.set(op.manager.id, op.manager)
              return { ...was, [deviceId]: { ...view, managers: [...managers.values()] } }
            }),
          error: () =>
            setViews((was) => ({
              ...was,
              [deviceId]: {
                deviceId,
                available: false,
                managers: was[deviceId]?.managers ?? [],
              },
            })),
        },
      ),
    )
    return () => {
      for (const stop of stops) stop()
    }
  }, [channel, ids])
  return {
    devices,
    managers: devices.flatMap((device) => views[device.id]?.managers ?? []),
    available: devices.filter(
      (device) => device.connection === 'online' && views[device.id]?.available === true,
    ),
  }
}

export function useManagerBoard(manager: ManagerView) {
  const { channel } = useServices()
  const [view, setView] = useState<ManagerBoardTopicView | null>(null)
  const [error, setError] = useState<unknown>(null)
  const { deviceId, id: managerId } = manager
  useEffect(() => {
    setView(null)
    setError(null)
    return channel.subscribe(
      { kind: 'managerBoard', deviceId, managerId },
      {
        snapshot: setView,
        delta: (ops) => {
          for (const op of ops) setView(op.view)
        },
        error: setError,
      },
    )
  }, [channel, deviceId, managerId])
  return { view, error }
}
