// 订阅设备上的项目权限；两端共用核心协议，React 钩子留在各自平台，避免重复加载 React。
import {
  type ChannelErrorShape,
  type ComposeOptions,
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
  harness: string,
  options?: ComposeOptions | null,
) {
  const t = useT()
  const path = cwd ?? ''
  const key = keys.projectPermission(deviceId, path, harness)
  const errorKey = keys.projectPermissionError(deviceId, path, harness)
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
    if (deviceId && harness) return replica.openProjectPermission(deviceId, path, harness)
  }, [replica, deviceId, path, harness])
  const persist = async (id: string | null | undefined, confirmed = false): Promise<void> => {
    const permission = permissionLevel(id)
    if (!permission || !deviceId || !harness) return
    if (view?.available === false) throw new Error(t('permission.project.unavailable'))
    const requiresConfirmation =
      options?.permissions.find((preset) => preset.id === permission)?.confirm ?? true
    confirmed = confirmed && requiresConfirmation
    if (
      permission === ':danger-full-access' &&
      requiresConfirmation &&
      !confirmed &&
      !view?.record?.confirmedPermissions.includes(permission)
    )
      throw new Error(t('permission.project.confirmFirst'))
    await channel.command('projectPermission.set', {
      deviceId,
      cwd: path,
      harness,
      permission,
      confirmed,
    })
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
    loading: Boolean(deviceId && harness && !view && !readError),
    saving,
    error: readError ? reasonOf(readError, t) : failure?.key === key ? failure.text : null,
    errorField: readError?.key,
    save,
    persist,
  }
}
