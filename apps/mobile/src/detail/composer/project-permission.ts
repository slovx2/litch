// 订阅设备上的项目权限；两端共用核心协议，React 钩子留在各自平台，避免重复加载 React。
import {
  type CoreChannel,
  keys,
  type ProjectPermissionView,
  permissionLevel,
  type Replica,
} from '@litch/core'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useT } from '../../ui/i18n'

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
    replica.store.get<{ message: string }>(errorKey),
  )
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<{ key: string; text: string } | null>(null)
  useEffect(() => {
    if (deviceId) return replica.openProjectPermission(deviceId, path)
  }, [replica, deviceId, path])
  const persist = async (id: string | null | undefined, confirmed = false): Promise<void> => {
    const permission = permissionLevel(id)
    if (!permission) return
    if (view?.available === false) throw new Error(t('permission.project.unavailable'))
    if (
      permission === ':danger-full-access' &&
      !confirmed &&
      !view?.record?.confirmedPermissions.includes(permission)
    )
      throw new Error(t('permission.project.confirmFirst'))
    await channel.command('projectPermission.set', { deviceId, cwd: path, permission, confirmed })
  }
  const save = async (id: string, confirmed: boolean): Promise<boolean> => {
    const permission = permissionLevel(id)
    if (!permission) return true
    if (saving) return false
    setSaving(true)
    setFailure(null)
    try {
      await persist(id, confirmed)
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
    loading: Boolean(deviceId && !view && !readError),
    saving,
    error: readError?.message ?? (failure?.key === key ? failure.text : null),
    save,
    persist,
  }
}
