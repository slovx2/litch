import { externalFilterKey, type Topic, type TopicData } from '@litch/core'
import { useEffect, useState } from 'react'
import { useServices } from '../app/services.tsx'

type ExternalKind = 'externalDevice' | 'externalIdentityLogin' | 'externalInbox' | 'externalOutbox'

export function useExternalTopic<K extends ExternalKind>(
  topic: Extract<Topic, { kind: K }> & { kind: K; deviceId: string },
  enabled = true,
): TopicData[K] | undefined {
  const { channel } = useServices()
  const keyed = topic as Extract<Topic, { kind: ExternalKind }>
  const key = JSON.stringify([
    keyed.kind,
    keyed.deviceId,
    'filter' in keyed ? externalFilterKey(keyed.filter) : 'loginId' in keyed ? keyed.loginId : null,
  ])
  const [state, setState] = useState<{ key: string; value: TopicData[K] }>()
  // 过滤值相同的订阅不重建；切设备或过滤项时不显示上一组结果。
  // biome-ignore lint/correctness/useExhaustiveDependencies: key 已包含整个主题
  useEffect(() => {
    if (!enabled) return
    return channel.subscribe<K>(topic, {
      snapshot: (value) => setState({ key, value }),
      delta() {},
      error: () => setState(undefined),
    })
  }, [channel, enabled, key])
  return enabled && state?.key === key ? state.value : undefined
}

export const externalOperationId = () => window.crypto.randomUUID()
export const externalTime = (seconds: number, lang: string) =>
  new Date(seconds * 1000).toLocaleString(lang)
