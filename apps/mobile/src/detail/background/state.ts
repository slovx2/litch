// 一个会话的后台任务：输入框上方那一行和“后台任务”页共用。和桌面一样合成一张（核心的 backgroundEntries）：
// 集合里的后台命令、引擎自己派出的子代理，界面上都叫后台任务（会话树里派出的子会话不算，用户要求，2026-10-25）。
// 集合：对面报的照侧栏摘要（SessionSummary.background），不报的用会话存储派生的那一份（meta.derived）；
// 子代理和它们报的状态从会话存储来（手机上副本不开会话，keys.agents 一直是空的）。
import {
  type BackgroundEntriesView,
  backgroundEntries,
  keys,
  type SessionBackgroundView,
  type SessionSummary,
} from '@litch/core'
import { useMemo, useSyncExternalStore } from 'react'
import type { SessionMeta, SessionStore } from '../../core/session-store'
import { useKey } from '../../shell/services'

/** 这个会话的后台命令的集合：报集合的照摘要，不报的照派生 */
export function useSessionBackground(store: SessionStore): SessionBackgroundView | null {
  const meta = useSyncExternalStore(store.subscribeMeta, store.getMeta)
  const summary = useKey<SessionSummary>(keys.summary(store.deviceId, store.sessionId))
  if (meta && !meta.can.backgroundTasks) return meta.derived
  return summary?.background ?? null
}

/** 合起来的整张：后台命令、子代理；running 是那一行上的数 */
export function useBackgroundEntries(store: SessionStore): BackgroundEntriesView | null {
  const background = useSessionBackground(store)
  const meta: SessionMeta | null = useSyncExternalStore(store.subscribeMeta, store.getMeta)
  const agents = meta?.agents
  const reported = meta?.reported
  return useMemo(
    () => backgroundEntries(background, agents ?? [], reported),
    [background, agents, reported],
  )
}
