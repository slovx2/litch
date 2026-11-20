// 手机上无人值守的数据入口：直接订阅核心的 externalDevice / externalInbox 主题（核心负责断线保留、重连重读）。
import {
  type ExternalDeviceView,
  type ExternalInboxFilter,
  type ExternalInboxView,
  externalFilterKey,
} from '@litch/core'
import { useEffect, useMemo, useState } from 'react'
import { useChannel } from '../../../shell/services'

/** 订阅一页收件箱；enabled 为 false 时不订（不在 GitHub 页签、设备不支持） */
export function useExternalInbox(
  deviceId: string,
  filter: ExternalInboxFilter,
  enabled: boolean,
): ExternalInboxView | undefined {
  const channel = useChannel()
  const key = externalFilterKey(filter)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 过滤条件按规范化的键比较
  const stable = useMemo(() => filter, [key])
  const [view, setView] = useState<{ key: string; value: ExternalInboxView } | undefined>()
  useEffect(() => {
    if (!enabled) return
    return channel.subscribe(
      { kind: 'externalInbox', deviceId, filter: stable },
      {
        snapshot: (value) => setView({ key, value }),
        delta: () => {},
        error: () => setView(undefined),
      },
    )
  }, [channel, deviceId, stable, key, enabled])
  return enabled && view?.key === key ? view.value : undefined
}

/** 订阅设备的无人值守快照：owner、来源、自启、配置与本连接的 access */
export function useExternalDevice(
  deviceId: string,
  enabled: boolean,
): ExternalDeviceView | undefined {
  const channel = useChannel()
  const [view, setView] = useState<ExternalDeviceView | undefined>()
  useEffect(() => {
    if (!enabled) {
      setView(undefined)
      return
    }
    return channel.subscribe(
      { kind: 'externalDevice', deviceId },
      {
        snapshot: (value) => setView(value),
        delta: () => {},
        error: () => setView(undefined),
      },
    )
  }, [channel, deviceId, enabled])
  return enabled ? view : undefined
}
