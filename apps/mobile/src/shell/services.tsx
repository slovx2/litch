// 全局的几样东西经上下文给页面：通往核心的通道、界面侧的数据副本（replica）、应用设置。
// 页面取数据的规矩：
// - 只从订阅拿数据，不经路由传；按键订阅（useKey），一个键变了只重画用它的那个组件。
// - 会话详情不走 replica，用 src/core/session-store.ts（对话区为流式专门做过的那一套）。
// 页面拿到的通道包了一层「最近」的记录（src/shell/activity.ts）：经它发出的主动操作计入最近，核心内部的不算。
import {
  type CoreChannel,
  createReplica,
  keys,
  type ManagerView,
  type Replica,
  sessionDestination,
  subscribeSessionDestination,
} from '@litch/core'
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
import { AppState, Platform } from 'react-native'
import type { SendMode } from '../../../../packages/ui/src/composer/send-mode-logic.ts'
import { sendModeOf } from '../detail/composer/send-mode'
import { backgroundMinutes } from '../platform/background'
import { ConsentPresentation } from '../privacy/ConsentPresentation'
import { type ConsentRequest, consentChannel } from '../privacy/consent'
import { aiConsentRecords } from '../privacy/storage'
import { consentTargets } from '../privacy/targets'
import { type Lang, useT } from '../ui/i18n'
import type { Skin } from '../ui/theme'
import { createMobileActivity, watchMobileActivity } from './activity'
import { type Booted, type BootMode, clock } from './boot'
import { devToolsEnabled, productionPrefs } from './build-mode'
import { navigationRef } from './dev-links'
import { jsonFile } from './json-file'

export interface Prefs {
  backgroundDisconnectMinutes: number | null
  lang: Lang | 'system'
  appearance: 'system' | 'light' | 'dark'
  skin: Skin
  /** 核心怎么装（src/shell/boot.ts）。正式用是 stored；开发、测试时用链接 litch://boot?mode=… 切换 */
  boot: BootMode
  /** 自动检查应用更新（src/update/）；关了只在设置页点“检查更新”时查 */
  autoUpdate: boolean
  /**
   * 会话列表里显不显示别的应用派出来的会话（Claude 桌面端起的 Claude Code 子会话，核心的 keys.nativeChildren）。
   * 照桌面侧栏默认不显示，开关在会话列表的“⋯”里
   */
  nativeChildren: boolean
  /** 回合进行中发的消息立即插进去还是排队（src/detail/composer/send-mode.ts），照桌面默认立即发送 */
  sendMode: SendMode
}

const DEFAULT_PREFS: Prefs = {
  backgroundDisconnectMinutes: 5,
  lang: 'system',
  appearance: 'system',
  skin: 'retro',
  boot: 'stored',
  autoUpdate: true,
  nativeChildren: false,
  sendMode: sendModeOf(null),
}
const prefsFile = jsonFile<Partial<Prefs>>('prefs.json')

export function loadPrefs(): Prefs {
  const saved = productionPrefs(prefsFile.read() ?? {})
  if (!devToolsEnabled()) {
    prefsFile.write(saved)
    jsonFile('remote-dev.json').remove()
    jsonFile('update-feed.json').remove()
  }
  return {
    ...DEFAULT_PREFS,
    ...saved,
    sendMode: sendModeOf(saved.sendMode),
    backgroundDisconnectMinutes: backgroundMinutes(saved.backgroundDisconnectMinutes),
  }
}

export function savePrefs(prefs: Prefs): void {
  prefsFile.write(productionPrefs(prefs))
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
  const t = useT()
  const [consentRequest, setConsentRequest] = useState<ConsentRequest | null>(null)
  // 记录按装法分开存：模拟核心的示例会话和真设备上的不混
  const activity = useMemo(
    () =>
      createMobileActivity(booted.channel, clock, jsonFile(`${booted.mode}-sidebar-activity.json`)),
    [booted],
  )
  const replica = useMemo(() => createReplica(activity.channel, activity), [activity])
  const consent = useMemo(
    () =>
      consentChannel(
        activity.channel,
        aiConsentRecords,
        consentTargets(
          activity.channel,
          replica,
          () => t.lang,
          () => t('privacy.ai.unavailable'),
        ),
        setConsentRequest,
        () => t('privacy.ai.cancelled'),
        Platform.OS,
      ),
    [activity, replica, t],
  )
  useEffect(() => () => consent.dispose(), [consent])
  useEffect(() => replica.start(), [replica])
  useEffect(
    () =>
      watchMobileActivity(
        activity,
        {
          current: () => AppState.currentState,
          listen(changed) {
            const subscription = AppState.addEventListener('change', changed)
            return () => subscription.remove()
          },
        },
        {
          current: () => (navigationRef.isReady() ? navigationRef.getCurrentRoute() : undefined),
          listen: (changed) => navigationRef.addListener('state', changed),
        },
        {
          get: (deviceId, managerId) =>
            replica.store.get<ManagerView>(keys.manager(deviceId, managerId))?.threadId,
          subscribe: (deviceId, managerId, changed) =>
            replica.store.subscribe(keys.manager(deviceId, managerId), changed),
          destination: (deviceId, sessionId) =>
            sessionDestination(replica.store, deviceId, sessionId),
          subscribeDestination: (deviceId, sessionId, changed) =>
            subscribeSessionDestination(replica.store, deviceId, sessionId, changed),
        },
      ),
    [activity, replica],
  )
  const value = useMemo(
    () => ({ booted, channel: consent.channel, replica, prefs, setPrefs }),
    [booted, consent, replica, prefs, setPrefs],
  )
  // 花括号不能省：onReady 的返回值会被当成清理函数，设置一变就拿它去调
  useEffect(() => {
    onReady?.(value)
  }, [onReady, value])
  return (
    <ServicesContext.Provider value={value}>
      <ConsentPresentation request={consentRequest}>{children}</ConsentPresentation>
    </ServicesContext.Provider>
  )
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
