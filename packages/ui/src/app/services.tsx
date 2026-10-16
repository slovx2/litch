// 界面取数据的唯一入口：通道、数据副本，以及“订阅状态库里的一个键”这个钩子。
import type { CoreChannel, Replica } from '@litch/core'
import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from 'react'

export interface Services {
  channel: CoreChannel
  replica: Replica
  /** 界面跑在哪：桌面外壳里，还是普通浏览器里（对着模拟核心） */
  shell: 'electron' | 'browser'
}

const ServicesContext = createContext<Services | null>(null)

export const ServicesProvider = ServicesContext.Provider

export function useServices(): Services {
  const services = useContext(ServicesContext)
  if (!services) throw new Error('界面还没接上核心')
  return services
}

/** 订阅状态库里的一个键。只有这个键的值换了，用它的组件才重画 */
export function useKey<T>(key: string): T | undefined {
  const { store } = useServices().replica
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(key, listener),
    [store, key],
  )
  return useSyncExternalStore(subscribe, () => store.get<T>(key))
}

/**
 * 一次订阅状态库里的几个键：哪一个的值换了都重画。键有几个不一定（比如每台设备一个），
 * 所以不能一个键调一次 useKey。返回的数组和给的键一一对应；键没变、值也都没换时还是上一次那个数组
 */
export function useKeys<T>(list: readonly string[]): readonly (T | undefined)[] {
  const { store } = useServices().replica
  // 键里没有换行符：拼成一个字符串，订阅和取值都只在键真的变了的时候才换
  const joined = list.join('\n')
  const last = useRef<{ joined: string; values: (T | undefined)[] } | null>(null)
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = (joined ? joined.split('\n') : []).map((key) => store.subscribe(key, listener))
      return () => {
        for (const stop of stops) stop()
      }
    },
    [store, joined],
  )
  return useSyncExternalStore(subscribe, () => {
    const values = (joined ? joined.split('\n') : []).map((key) => store.get<T>(key))
    const was = last.current
    if (was?.joined === joined && values.every((value, at) => Object.is(value, was.values[at]))) {
      return was.values
    }
    last.current = { joined, values }
    return values
  })
}
