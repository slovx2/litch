// 订阅设备上的项目权限；两端共用核心协议，React 钩子留在各自平台，避免重复加载 React。
import {
  type ChannelErrorShape,
  type CoreChannel,
  keys,
  type ProjectPermissionView,
  permissionLevel,
  type Replica,
} from '@litch/core'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'

export function useProjectPermission(
  { channel, replica }: { channel: CoreChannel; replica: Replica },
  deviceId: string,
  cwd: string | null | undefined,
) {
  const t = useT()
  const path = cwd ?? ''
  const key = keys.projectPermission(deviceId, path)
  const errorKey = keys.projectPermissionError(deviceId, path)
  const watch = useCallback(
    (notify: () => void) => replica.store.subscribe(key, notify),
    [replica, key],
  )
  const watchError = useCallback(
    (notify: () => void) => replica.store.subscribe(errorKey, notify),
    [replica, errorKey],
  )
  const view = useSyncExternalStore(watch, () => replica.store.get<ProjectPermissionView>(key))
  const readError = useSyncExternalStore(watchError, () =>
    replica.store.get<ChannelErrorShape>(errorKey),
  )
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<{ key: string; text: string } | null>(null)
  useEffect(() => {
    if (deviceId && path) return replica.openProjectPermission(deviceId, path)
  }, [replica, deviceId, path])
  const save = async (id: string, confirmed: boolean): Promise<boolean> => {
    const permission = permissionLevel(id)
    if (!path || !permission || view?.available === false) return true
    if (!view?.record || saving) return false
    setSaving(true)
    setFailure(null)
    try {
      await channel.command('projectPermission.set', { deviceId, cwd: path, permission, confirmed })
      return true
    } catch (error) {
      setFailure({ key, text: error instanceof Error ? error.message : String(error) })
      return false
    } finally {
      setSaving(false)
    }
  }
  return {
    view,
    permission: view?.record?.permission ?? null,
    confirmed: (id: string) =>
      view?.record?.confirmedPermissions.some((entry) => entry === id) === true,
    loading: Boolean(deviceId && path && !view && !readError),
    saving,
    error: readError ? reasonOf(readError, t) : failure?.key === key ? failure.text : null,
    errorField: readError?.key,
    save,
  }
}
