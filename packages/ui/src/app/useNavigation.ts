import { keys } from '@litch/core'
import { useCallback, useState, useSyncExternalStore } from 'react'
import { historyOf, travel } from './history.ts'
import { navigationHistory } from './navigation-history.ts'
import { useServices } from './services.tsx'
import { initialNavigation, type NavigationAction, type ViewNavigation } from './view-navigation.ts'

export function useNavigation(valid: (location: ViewNavigation) => boolean) {
  const [history, setHistory] = useState(() => historyOf(initialNavigation))
  const { store } = useServices().replica
  const watched = [
    ...new Set(
      history.entries.flatMap((entry) => {
        const { picked, page } = entry[entry.mode]
        return picked && !page ? [keys.summary(picked.deviceId, picked.sessionId)] : []
      }),
    ),
  ].join('\n')
  // 只订阅“还在不在”；摘要的运行进度变化不重画应用。历史会话被删后按钮立即更新。
  useSyncExternalStore(
    useCallback(
      (listener) => {
        const stops = (watched ? watched.split('\n') : []).map((key) =>
          store.subscribe(key, listener),
        )
        return () => {
          for (const stop of stops) stop()
        }
      },
      [store, watched],
    ),
    () => history.entries.map((entry) => Number(valid(entry))).join(''),
  )
  const navigation = history.entries[history.index] ?? initialNavigation
  const dispatch = useCallback(
    (action: NavigationAction) => setHistory((was) => navigationHistory(was, action)),
    [],
  )
  const go = useCallback(
    (direction: -1 | 1) => setHistory((was) => travel(was, direction, valid)),
    [valid],
  )
  return {
    navigation,
    dispatch,
    go,
    back: travel(history, -1, valid) !== history,
    forward: travel(history, 1, valid) !== history,
  }
}
