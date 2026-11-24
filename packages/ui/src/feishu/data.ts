// 飞书的数据入口：界面只经这里订阅核心的 feishuDevice / feishuRegistration 主题、调 feishu.* 命令。
// 本机和远程设备走同一条通道，核心负责断线保留与重连重读。
import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  FeishuBindingsView,
  FeishuChatsView,
  FeishuDeviceView,
  FeishuInboxView,
  FeishuOutboxView,
  FeishuRegistrationView,
  ReviewsView,
} from '../../../core/src/projection/feishu.mts'
import { useT } from '../app/appearance.ts'
import { useServices } from '../app/services.tsx'
import { feishuFailure } from './failure.ts'
import { type FeishuApp, type FeishuChat, feishuReason, staleReason } from './model.ts'

/** 写操作成功后把设备回的应用交给页面，不等快照重读 */
export type OnApp = (app: FeishuApp) => void
/** 群的写操作成功后把设备回的群交给列表 */
export type OnChat = (chat: FeishuChat) => void

type Topic =
  | { kind: 'feishuDevice'; deviceId: string }
  | { kind: 'feishuRegistration'; deviceId: string; registrationId: string }
  | { kind: 'feishuChats'; deviceId: string; appId: string }
  | { kind: 'feishuInbox'; deviceId: string; managerId: string }
  | { kind: 'feishuOutbox'; deviceId: string; appId: string }
  | { kind: 'feishuBindings'; deviceId: string; appId: string }
  | { kind: 'reviews'; deviceId: string; managerId?: string }

/** 订一个主题，取最新快照；topic 为 null 时不订 */
function useTopic<T>(topic: Topic | null): T | undefined {
  const { channel } = useServices()
  const [value, setValue] = useState<T>()
  const key = topic ? JSON.stringify(topic) : ''
  // biome-ignore lint/correctness/useExhaustiveDependencies: 主题按内容比较
  useEffect(() => {
    setValue(undefined)
    if (!topic) return
    return channel.subscribe(topic as never, {
      snapshot: (data: unknown) => setValue(data as T),
      delta: () => {},
      error: () => setValue(undefined),
    })
  }, [channel, key])
  return value
}

export function useFeishuDevice(deviceId: string, enabled = true) {
  return useTopic<FeishuDeviceView>(enabled ? { kind: 'feishuDevice', deviceId } : null)
}

export function useFeishuRegistration(deviceId: string, registrationId: string | null) {
  return useTopic<FeishuRegistrationView>(
    registrationId ? { kind: 'feishuRegistration', deviceId, registrationId } : null,
  )
}

/** 一个应用的机器人所在的群；设备离线时核心保留上次读到的 */
export function useFeishuChats(deviceId: string, appId: string) {
  return useTopic<FeishuChatsView>({ kind: 'feishuChats', deviceId, appId })
}

/** 经理绑着的飞书应用（设备不支持飞书、没绑时是 null）：经理页据此决定出不出“飞书”页签 */
export function useManagerFeishuApp(
  deviceId: string,
  managerId: string,
  supported: boolean,
): FeishuApp | null {
  const view = useFeishuDevice(deviceId, supported)
  if (!supported) return null
  return view?.apps.value?.find((app) => app.managerId === managerId) ?? null
}

/** 经理的飞书收件箱：最近一页（新的在前）；enabled 为 false 时不订 */
export function useFeishuInbox(deviceId: string, managerId: string, enabled = true) {
  return useTopic<FeishuInboxView>(enabled ? { kind: 'feishuInbox', deviceId, managerId } : null)
}

/** 一个应用的发件队列：最近一页（新的在前） */
export function useFeishuOutbox(deviceId: string, appId: string) {
  return useTopic<FeishuOutboxView>({ kind: 'feishuOutbox', deviceId, appId })
}

/** 一个应用的私聊绑定（已绑定和撤销过的） */
export function useFeishuBindings(deviceId: string, appId: string) {
  return useTopic<FeishuBindingsView>({ kind: 'feishuBindings', deviceId, appId })
}

/**
 * 这位经理发起的审批（待批在前）；enabled 为 false 时不订。
 * 设备没有审批扩展时 available 为 false，界面不出审批入口
 */
export function useReviews(deviceId: string, managerId: string, enabled = true) {
  return useTopic<ReviewsView>(enabled ? { kind: 'reviews', deviceId, managerId } : null)
}

/**
 * 一次命令的忙与错：run 返回结果，失败时记下原因并返回 undefined。
 * 版本冲突（或群的接入状态已在别处变了）时先调 onConflict（重读），提示换成“已重新读取，请重试”
 */
export function useFeishuRun(onConflict?: () => void) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = useCallback(
    async <R>(request: () => Promise<R>): Promise<R | undefined> => {
      setBusy(true)
      setError('')
      try {
        return await request()
      } catch (cause) {
        if (staleReason(feishuReason(cause))) onConflict?.()
        setError(feishuFailure(cause, t))
        return undefined
      } finally {
        setBusy(false)
      }
    },
    [t, onConflict],
  )
  return useMemo(() => ({ busy, error, run, setError }), [busy, error, run])
}
