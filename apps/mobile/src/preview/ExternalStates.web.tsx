// 无人值守的受阻状态：完整应用对着隔离模拟核心，订阅快照里注入投递受阻、通知权限缺失、未回原帖和最近一次空闲压缩。
// 只在网页预览中存在；地址 at=device|console|github|overview 决定落在哪一页，appearance、skin、lang 同其他场景。
import {
  connectChannel,
  createMockCore,
  createPortPair,
  type ExternalDeviceView,
  type ExternalInboxView,
  type ExternalMissingResultReply,
  serveChannel,
} from '@litch/core'
import { NavigationContainer } from '@react-navigation/native'
import { useEffect, useMemo } from 'react'
import { useColorScheme } from 'react-native'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { Navigator } from '../nav/Navigator'
import { ConsentPresentation } from '../privacy/ConsentPresentation'
import { clock } from '../shell/boot'
import { navigationRef } from '../shell/dev-links'
import { loadPrefs, ServicesProvider } from '../shell/services'
import { I18nContext, translator } from '../ui/i18n'
import { makeTheme, SKINS, type Skin, ThemeContext } from '../ui/theme'

const core = createMockCore({ clock, lang: 'zh-CN' })
const [client, server] = createPortPair()
serveChannel(server, core, { clock })
const channel = connectChannel(client)
const recovery = { managerId: 'm1', threadId: 'manager-k1', action: 'refresh' as const }
const missing = (issueId: `X-${number}`, n: number): ExternalMissingResultReply => ({
  managerId: 'm1',
  issueId,
  subject: {
    provider: 'github',
    kind: 'issue',
    repoId: '123',
    number: String(n),
    url: `https://github.com/example/demo/issues/${n}`,
  },
})

function blockedDevice(view: ExternalDeviceView): ExternalDeviceView {
  const sources = view.sources.value?.map((status, index) => {
    if (index > 0 || !status.readiness) return status
    return {
      ...status,
      missingResultReplies: [missing('X-1', 8), missing('X-3', 12)],
      readiness: {
        ...status.readiness,
        collect: {
          ...status.readiness.collect,
          diagnostics: [
            ...status.readiness.collect.diagnostics,
            {
              check: 'notifications',
              state: 'blocked' as const,
              code: 'github_notifications_scope_required',
            },
          ],
        },
        notify: {
          state: 'blocked' as const,
          diagnostics: [
            {
              check: 'managerTools',
              state: 'blocked' as const,
              code: 'manager_tools_outdated',
              recovery,
            },
          ],
        },
      },
    }
  })
  return { ...view, sources: { ...view.sources, ...(sources ? { value: sources } : {}) } }
}

function blockedInbox(view: ExternalInboxView): ExternalInboxView {
  if (!view.value) return view
  return {
    ...view,
    value: {
      ...view.value,
      entries: view.value.entries.map((entry, index) =>
        index === 0 && entry.status === 'pending_triage'
          ? {
              ...entry,
              delivery: { state: 'blocked', reason: 'manager_tools_outdated', recovery },
              missingResultReply: missing('X-1', 8),
            }
          : entry,
      ),
    },
  }
}

type Sink = { snapshot?: (value: never) => void }
const subscribe = channel.subscribe.bind(channel)
channel.subscribe = ((topic: { kind: string }, sink: Sink) => {
  const inject =
    topic.kind === 'externalDevice'
      ? blockedDevice
      : topic.kind === 'externalInbox'
        ? blockedInbox
        : null
  if (!inject || !sink.snapshot) return subscribe(topic as never, sink as never)
  const snapshot = sink.snapshot
  return subscribe(
    topic as never,
    { ...sink, snapshot: (value: never) => snapshot(inject(value) as never) } as never,
  )
}) as typeof channel.subscribe
const booted = { mode: 'mock' as const, work: null, channel, stop: () => channel.close() }
const noop = () => {}

const TARGETS = {
  device: ['DeviceDetail', { deviceId: 'local' }],
  console: ['ManagerConsole', { deviceId: 'local', managerId: 'm1', tab: 'console' }],
  github: ['ManagerConsole', { deviceId: 'local', managerId: 'm1', tab: 'github' }],
  overview: ['ManagerConsole', { deviceId: 'local', managerId: 'm1', tab: 'overview' }],
} as const

export function ExternalStatesPreview({ params }: { params: URLSearchParams }) {
  const system = useColorScheme()
  const appearance = params.get('appearance')
  const dark = appearance === 'dark' || (appearance !== 'light' && system === 'dark')
  const skin = SKINS.includes(params.get('skin') as Skin)
    ? (params.get('skin') as Skin)
    : 'standard'
  const theme = useMemo(() => makeTheme(skin, dark), [skin, dark])
  const lang = params.get('lang') === 'en' ? 'en' : 'zh-CN'
  const at = (params.get('at') ?? 'device') as keyof typeof TARGETS
  useEffect(() => {
    const target = TARGETS[at] ?? TARGETS.device
    const go = () => {
      if (!navigationRef.isReady()) return void setTimeout(go, 50)
      const navigate = navigationRef.navigate as (route: string, args: unknown) => void
      navigate(target[0], target[1])
    }
    go()
  }, [at])
  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <ThemeContext.Provider value={theme}>
          <I18nContext.Provider value={translator(lang)}>
            <ConsentPresentation>
              <ServicesProvider booted={booted} prefs={loadPrefs()} setPrefs={noop}>
                <NavigationContainer ref={navigationRef}>
                  <Navigator />
                </NavigationContainer>
              </ServicesProvider>
            </ConsentPresentation>
          </I18nContext.Provider>
        </ThemeContext.Provider>
      </KeyboardProvider>
    </SafeAreaProvider>
  )
}
