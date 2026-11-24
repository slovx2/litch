// 手机上飞书的数据入口：直接订阅核心的 feishuDevice / feishuRegistration / feishuChats / feishuInbox / feishuOutbox / feishuBindings / reviews 主题（核心负责断线保留、重连重读），
// 同设备在用的经理从数据副本取。
import { keys, type ManagerView } from '@litch/core'
import { useEffect, useMemo, useState } from 'react'
import type {
  FeishuBindingsView,
  FeishuChatsView,
  FeishuDeviceView,
  FeishuInboxView,
  FeishuOutboxView,
  FeishuRegistrationView,
  ReviewsView,
} from '../../../../../../packages/core/src/projection/feishu.mts'
import type { FeishuApp, ManagerChoice } from '../../../../../../packages/ui/src/feishu/model.ts'
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

/** 一个应用的机器人所在的群 */
export function useFeishuChats(
  deviceId: string,
  appId: string,
  enabled: boolean,
): FeishuChatsView | undefined {
  const channel = useChannel()
  const [view, setView] = useState<FeishuChatsView | undefined>()
  useEffect(() => {
    setView(undefined)
    if (!enabled) return
    return channel.subscribe(
      { kind: 'feishuChats', deviceId, appId },
      {
        snapshot: (value) => setView(value),
        delta: () => {},
        error: () => setView(undefined),
      },
    )
  }, [channel, deviceId, appId, enabled])
  return enabled ? view : undefined
}

/** 经理绑着的飞书应用；设备不支持飞书或没绑时是 null（经理页据此出不出“飞书”页签） */
export function useManagerFeishuApp(
  deviceId: string,
  managerId: string,
  supported: boolean,
): FeishuApp | null {
  const view = useFeishuDevice(deviceId, supported)
  return view?.apps.value?.find((app) => app.managerId === managerId) ?? null
}

/** 经理的飞书收件箱：最近一页（新的在前） */
export function useFeishuInbox(
  deviceId: string,
  managerId: string,
  enabled: boolean,
): FeishuInboxView | undefined {
  const channel = useChannel()
  const [view, setView] = useState<FeishuInboxView | undefined>()
  useEffect(() => {
    setView(undefined)
    if (!enabled) return
    return channel.subscribe(
      { kind: 'feishuInbox', deviceId, managerId },
      {
        snapshot: (value) => setView(value),
        delta: () => {},
        error: () => setView(undefined),
      },
    )
  }, [channel, deviceId, managerId, enabled])
  return enabled ? view : undefined
}

/** 一个应用的发件队列：最近一页（新的在前） */
export function useFeishuOutbox(deviceId: string, appId: string): FeishuOutboxView | undefined {
  const channel = useChannel()
  const [view, setView] = useState<FeishuOutboxView | undefined>()
  useEffect(() => {
    setView(undefined)
    return channel.subscribe(
      { kind: 'feishuOutbox', deviceId, appId },
      {
        snapshot: (value) => setView(value),
        delta: () => {},
        error: () => setView(undefined),
      },
    )
  }, [channel, deviceId, appId])
  return view
}

/** 一个应用的私聊绑定（已绑定和撤销过的） */
export function useFeishuBindings(deviceId: string, appId: string): FeishuBindingsView | undefined {
  const channel = useChannel()
  const [view, setView] = useState<FeishuBindingsView | undefined>()
  useEffect(() => {
    setView(undefined)
    return channel.subscribe(
      { kind: 'feishuBindings', deviceId, appId },
      {
        snapshot: (value) => setView(value),
        delta: () => {},
        error: () => setView(undefined),
      },
    )
  }, [channel, deviceId, appId])
  return view
}

/** 这位经理发起的审批（待批在前）；设备没有审批扩展时 available 为 false */
export function useReviews(
  deviceId: string,
  managerId: string,
  enabled: boolean,
): ReviewsView | undefined {
  const channel = useChannel()
  const [view, setView] = useState<ReviewsView | undefined>()
  useEffect(() => {
    setView(undefined)
    if (!enabled) return
    return channel.subscribe(
      { kind: 'reviews', deviceId, managerId },
      {
        snapshot: (value) => setView(value),
        delta: () => {},
        error: () => setView(undefined),
      },
    )
  }, [channel, deviceId, managerId, enabled])
  return enabled ? view : undefined
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
