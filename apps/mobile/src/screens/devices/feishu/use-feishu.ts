// 手机上飞书的数据入口：直接订阅核心的 feishuDevice / feishuRegistration 主题（核心负责断线保留、重连重读），
// 同设备在用的经理从数据副本取。
import { keys, type ManagerView } from '@litch/core'
import { useEffect, useMemo, useState } from 'react'
import type {
  FeishuDeviceView,
  FeishuRegistrationView,
} from '../../../../../../packages/core/src/projection/feishu.mts'
import type { ManagerChoice } from '../../../../../../packages/ui/src/feishu/model.ts'
import { useChannel, useKey, useReplica } from '../../../shell/services'

export function useFeishuDevice(deviceId: string, enabled: boolean): FeishuDeviceView | undefined {
  const channel = useChannel()
  const [view, setView] = useState<FeishuDeviceView | undefined>()
  useEffect(() => {
    if (!enabled) {
      setView(undefined)
      return
    }
    return channel.subscribe(
      { kind: 'feishuDevice', deviceId },
      {
        snapshot: (value) => setView(value),
        delta: () => {},
        error: () => setView(undefined),
      },
    )
  }, [channel, deviceId, enabled])
  return enabled ? view : undefined
}

export function useFeishuRegistration(
  deviceId: string,
  registrationId: string | null,
): FeishuRegistrationView | undefined {
  const channel = useChannel()
  const [view, setView] = useState<FeishuRegistrationView | undefined>()
  useEffect(() => {
    setView(undefined)
    if (!registrationId) return
    return channel.subscribe(
      { kind: 'feishuRegistration', deviceId, registrationId },
      {
        snapshot: (value) => setView(value),
        delta: () => {},
        error: () => setView(undefined),
      },
    )
  }, [channel, deviceId, registrationId])
  return registrationId ? view : undefined
}

/** 这台设备上在用的经理（选经理用）。经理视图变了跟着重画：订经理列表，名字按需从副本取 */
export function useDeviceManagers(deviceId: string): ManagerChoice[] {
  const replica = useReplica()
  const ids = useKey<string[]>(keys.managerIds(deviceId))
  return useMemo(
    () =>
      (ids ?? []).flatMap((id) => {
        const one = replica.store.get<ManagerView>(keys.manager(deviceId, id))
        return one?.status === 'active' ? [{ id: one.id, name: one.name }] : []
      }),
    [ids, replica, deviceId],
  )
}
