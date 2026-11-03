// 订阅设备上的项目权限；两端共用核心协议，React 钩子留在各自平台，避免重复加载 React。
import {
  type ComposeOptions,
  type CoreChannel,
  keys,
  type PermissionLevel,
  type ProjectPermissionView,
  permissionLevel,
  type Replica,
} from '@litch/core'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useT } from '../../ui/i18n'

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
    replica.store.get<{ message: string }>(errorKey),
  )
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<{ key: string; text: string } | null>(null)
  // 表单内的选择优先于设备记忆；无法保存的确认只允许本次发送，不共享给下一张表单。
  const [selection, setSelection] = useState<{ key: string; permission: PermissionLevel } | null>(
    null,
  )
  const confirmedOnce = useRef<{ key: string; permission: PermissionLevel } | null>(null)
  useEffect(() => {
    if (deviceId && harness) return replica.openProjectPermission(deviceId, path, harness)
  }, [replica, deviceId, path, harness])
  const persist = async (
    id: string | null | undefined,
    confirmed = false,
    consume = true,
  ): Promise<string | null> => {
    const permission = permissionLevel(id)
    if (!permission) return null
    const requiresConfirmation =
      options?.permissions.find((preset) => preset.id === permission)?.confirm ?? true
    confirmed = confirmed && requiresConfirmation
    const once =
      confirmedOnce.current?.key === key && confirmedOnce.current.permission === permission
    if (
      permission === ':danger-full-access' &&
      requiresConfirmation &&
      !confirmed &&
      !once &&
      !view?.record?.confirmedPermissions.includes(permission)
    )
      throw new Error(t('permission.project.confirmFirst'))
    // 记忆是辅助功能；确认要求已满足后，持久化失败不能阻断按当前档位新建。
    let notice: string | null = null
    try {
      if (!deviceId || !harness) return null
      if (view?.available === false) notice = t('permission.project.unavailable')
      else
        await channel.command('projectPermission.set', {
          deviceId,
          cwd: path,
          harness,
          permission,
          confirmed: requiresConfirmation && (confirmed || once),
        })
    } catch {
      notice = t('permission.project.saveFailed', { reason: t('permission.project.failedReason') })
    } finally {
      if (consume && once) confirmedOnce.current = null
    }
    setFailure(notice ? { key, text: notice } : null)
    return notice
  }
  const save = async (id: string, confirmed: boolean, consume = false): Promise<boolean> => {
    const permission = permissionLevel(id)
    if (!permission) return true
    if (saving) return false
    setSaving(true)
    setFailure(null)
    try {
      await persist(id, confirmed, false)
      setSelection({ key, permission })
      if (
        confirmed &&
        (options?.permissions.find((preset) => preset.id === permission)?.confirm ?? true) &&
        !consume
      )
        confirmedOnce.current = { key, permission }
      else confirmedOnce.current = null
      return true
    } catch {
      setFailure({ key, text: t('permission.project.confirmFirst') })
      return false
    } finally {
      setSaving(false)
    }
  }
  return {
    view,
    permission: selection?.key === key ? selection.permission : (view?.record?.permission ?? null),
    confirmed: (id: string) =>
      view?.record?.confirmedPermissions.some((entry) => entry === id) === true ||
      (confirmedOnce.current?.key === key && confirmedOnce.current.permission === id),
    loading: Boolean(deviceId && harness && !view && !readError),
    saving,
    notice:
      failure?.key === key
        ? failure.text
        : view?.available === false
          ? t('permission.project.unavailable')
          : readError
            ? t('permission.project.saveFailed', { reason: t('permission.project.failedReason') })
            : null,
    save,
    persist,
  }
}

export type ProjectPermissionController = ReturnType<typeof useProjectPermission>
