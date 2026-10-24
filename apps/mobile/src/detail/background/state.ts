// 一个会话的后台任务：输入框上方那一行和“后台任务”页共用。和桌面一样合成一张（核心的 backgroundEntries）：
// 集合里的后台命令、引擎自己派出的子代理、会话树里这个会话派出的子会话，界面上都叫后台任务。
// 集合：对面报的照侧栏摘要（SessionSummary.background），不报的用会话存储派生的那一份（meta.derived）；
// 子代理和它们报的状态从会话存储来（手机上副本不开会话，keys.agents 一直是空的）；子会话从副本的 keys.children 和摘要来。
import {
  type BackgroundChildInput,
  type BackgroundEntriesView,
  backgroundEntries,
  keys,
  type SessionBackgroundView,
  type SessionChildren,
  type SessionSummary,
} from '@litch/core'
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import type { SessionMeta, SessionStore } from '../../core/session-store'
import { useKey, useReplica } from '../../shell/services'

/** 这个会话的后台命令的集合：报集合的照摘要，不报的照派生 */
export function useSessionBackground(store: SessionStore): SessionBackgroundView | null {
  const meta = useSyncExternalStore(store.subscribeMeta, store.getMeta)
  const summary = useKey<SessionSummary>(keys.summary(store.deviceId, store.sessionId))
  if (meta && !meta.can.backgroundTasks) return meta.derived
  return summary?.background ?? null
}

const NO_IDS: readonly string[] = []

/** 几个摘要一起订：任一变了换一个新数组，都没变还是原来那个 */
function useSummaries(deviceId: string, ids: readonly string[]): (SessionSummary | undefined)[] {
  const { store } = useReplica()
  const last = useRef<(SessionSummary | undefined)[]>([])
  const subscribe = useCallback(
    (listener: () => void) => {
      const offs = ids.map((id) => store.subscribe(keys.summary(deviceId, id), listener))
      return () => {
        for (const off of offs) off()
      }
    },
    [store, deviceId, ids],
  )
  const get = useCallback(() => {
    const next = ids.map((id) => store.get<SessionSummary>(keys.summary(deviceId, id)))
    const prev = last.current
    if (next.length !== prev.length || next.some((value, at) => value !== prev[at]))
      last.current = next
    return last.current
  }, [store, deviceId, ids])
  return useSyncExternalStore(subscribe, get)
}

/** 会话树里这个会话派出的子会话（Litch 自己派的） */
function useChildren(deviceId: string, sessionId: string): BackgroundChildInput[] {
  const children = useKey<SessionChildren>(keys.children(deviceId))
  const ids = children?.[sessionId] ?? NO_IDS
  const summaries = useSummaries(deviceId, ids)
  return useMemo(
    () =>
      summaries.flatMap((summary) =>
        summary && summary.lineage?.parentId === sessionId
          ? [
              {
                id: summary.id,
                title:
                  summary.lineage.title || (typeof summary.title === 'string' ? summary.title : ''),
                status: summary.status,
                startedAt: summary.lineage.createdAt || null,
                updatedAt: summary.updatedAt || null,
              },
            ]
          : [],
      ),
    [summaries, sessionId],
  )
}

/** 合起来的整张：后台命令、子代理、子会话；running 是那一行上的数 */
export function useBackgroundEntries(store: SessionStore): BackgroundEntriesView | null {
  const background = useSessionBackground(store)
  const meta: SessionMeta | null = useSyncExternalStore(store.subscribeMeta, store.getMeta)
  const children = useChildren(store.deviceId, store.sessionId)
  const agents = meta?.agents
  const reported = meta?.reported
  return useMemo(
    () => backgroundEntries(background, agents ?? [], children, reported),
    [background, agents, children, reported],
  )
}
