// 全局的几样东西经上下文给页面：通往核心的通道、界面侧的数据副本（replica）、应用设置。
// 页面取数据的规矩：
// - 只从订阅拿数据，不经路由传；按键订阅（useKey），一个键变了只重画用它的那个组件。
// - 会话详情不走 replica，用 src/core/session-store.ts（对话区为流式专门做过的那一套）。
import { type CoreChannel, createReplica, type Replica } from '@litch/core'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import type { Lang } from '../ui/i18n'
import type { Booted, BootMode } from './boot'
import { jsonFile } from './json-file'

export interface Prefs {
  lang: Lang | 'system'
  appearance: 'system' | 'light' | 'dark'
  /** 核心怎么装（src/shell/boot.ts）。正式用是 stored；开发、测试时用链接 litch://boot?mode=… 切换 */
  boot: BootMode
  /** 自动检查应用更新（src/update/）；关了只在设置页点“检查更新”时查 */
  autoUpdate: boolean
}

const DEFAULT_PREFS: Prefs = {
  lang: 'system',
  appearance: 'system',
  boot: 'stored',
  autoUpdate: true,
}
const prefsFile = jsonFile<Partial<Prefs>>('prefs.json')

export function loadPrefs(): Prefs {
  return { ...DEFAULT_PREFS, ...(prefsFile.read() ?? {}) }
}

export function savePrefs(prefs: Prefs): void {
  prefsFile.write(prefs)
}

export interface Services {
  booted: Booted
  channel: CoreChannel
  replica: Replica
  prefs: Prefs
  setPrefs(patch: Partial<Prefs>): void
}

const ServicesContext = createContext<Services | null>(null)

export function ServicesProvider({
  booted,
  prefs,
  setPrefs,
  onReady,
  children,
}: {
  booted: Booted
  prefs: Prefs
  setPrefs(patch: Partial<Prefs>): void
  /** 每次 services 换了都告诉外面一声（测试链接的监听器要拿最新的） */
  onReady?(services: Services): void
  children: ReactNode
}) {
  const replica = useMemo(() => createReplica(booted.channel), [booted])
  useEffect(() => replica.start(), [replica])
  const value = useMemo(
    () => ({ booted, channel: booted.channel, replica, prefs, setPrefs }),
    [booted, replica, prefs, setPrefs],
  )
  // 花括号不能省：onReady 的返回值会被当成清理函数，设置一变就拿它去调
  useEffect(() => {
    onReady?.(value)
  }, [onReady, value])
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>
}

export function useServices(): Services {
  const services = useContext(ServicesContext)
  if (!services) throw new Error('ServicesProvider 外面用不了 useServices')
  return services
}

export const useChannel = (): CoreChannel => useServices().channel

export const useReplica = (): Replica => useServices().replica

/** 订阅 replica 状态库里的一个键（键见 @litch/core 的 keys）。值是不可变的，引用变了才重画 */
export function useKey<T>(key: string): T | undefined {
  const { store } = useReplica()
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(key, listener),
    [store, key],
  )
  const get = useCallback(() => store.get<T>(key), [store, key])
  return useSyncExternalStore(subscribe, get)
}

/** 一个异步命令的进行状态：页面上“正在做、做完、出错”三态用 */
export function useBusy(): [boolean, <T>(work: Promise<T>) => Promise<T>] {
  const [busy, setBusy] = useState(false)
  const run = useCallback(async <T,>(work: Promise<T>) => {
    setBusy(true)
    try {
      return await work
    } finally {
      setBusy(false)
    }
  }, [])
  return [busy, run]
}
