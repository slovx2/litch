// 接班流程的正式手机组件，对着隔离模拟核心；状态注入只存在网页预览中。
import {
  connectChannel,
  createMockCore,
  createPortPair,
  type ManagerResetPreview,
  type ManagerView,
  serveChannel,
} from '@litch/core'
import { NavigationContainer } from '@react-navigation/native'
import { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { sampleManagers } from '../../../../packages/core/src/mock/sample-manager.mts'
import { ConsentPresentation } from '../privacy/ConsentPresentation'
import { useManagerReset } from '../screens/managers/use-reset'
import { clock } from '../shell/boot'
import { loadPrefs, ServicesProvider } from '../shell/services'
import { I18nContext, translator, useT } from '../ui/i18n'
import { Button } from '../ui/kit/controls'
import { makeTheme, SKINS, type Skin, ThemeContext, useTheme } from '../ui/theme'

const calls: unknown[] = []
const core = createMockCore({ clock, lang: 'zh-CN' })
const [client, server] = createPortPair()
serveChannel(server, core, { clock })
const channel = connectChannel(client)
const original = channel.command.bind(channel)
channel.command = new Proxy(original, {
  apply(target, receiver, args) {
    calls.push(args)
    return Reflect.apply(target, receiver, args)
  },
})
const booted = { mode: 'mock' as const, work: null, channel, stop: () => channel.close() }
const noop = () => {}
const initial = (() => {
  const value = sampleManagers('local', Date.now(), 'zh-CN').managers[0]
  if (!value) throw new Error('缺少隔离经理数据')
  return value
})()

function Body({ phase, plan }: { phase: string; plan: ManagerResetPreview }) {
  const t = useT()
  const theme = useTheme()
  const [manager, setManager] = useState<ManagerView>(() => {
    if (!['waiting', 'summaryFailed', 'handoverFailed'].includes(phase)) return initial
    return {
      ...initial,
      reset: {
        mode: 'replace',
        current: 'new',
        applied: 'old',
        outdated: false,
        phase: phase === 'handoverFailed' ? 'failed' : (phase as 'waiting' | 'summaryFailed'),
        operation: {
          requestId: 'preview-reset',
          source: { ...plan.source, threadId: initial.threadId },
          target: plan.target,
          expectedSettingsHash: plan.expectedSettingsHash,
          candidateThreadId: null,
          committed: phase === 'handoverFailed',
          handover: phase === 'handoverFailed' ? 'failed' : 'pending',
        },
      },
    }
  })
  const reset = useManagerReset(manager, true, phase !== 'old-device')
  useEffect(() => {
    Object.assign(window, {
      __managerReset: {
        calls,
        manager,
        cancel: () => reset.cancelActions[0]?.onPress(),
        setManager: (patch: Partial<ManagerView>) =>
          setManager((value) => ({ ...value, ...patch })),
      },
    })
  })
  return (
    <View style={{ flex: 1, padding: 16, gap: 16, backgroundColor: theme.c.win }}>
      <Text style={{ color: theme.c.ink, fontSize: theme.font.size.body }}>{initial.name}</Text>
      <Button
        label={t('manager.reset')}
        testID="manager:reset"
        onPress={() => reset.menu[0]?.onPress()}
      />
      {reset.status}
      {reset.cancelActions.map((action) => (
        <Button
          key={action.testID}
          label={action.label}
          testID={action.testID}
          onPress={() => {
            action.onPress()
            setManager((value) =>
              value.reset ? { ...value, reset: { ...value.reset, phase: 'idle' } } : value,
            )
          }}
        />
      ))}
      {reset.overlay}
    </View>
  )
}

export function ManagerResetPreviewScreen({ params }: { params: URLSearchParams }) {
  const skin = params.get('skin') as Skin
  const [look, setLook] = useState({
    skin: SKINS.includes(skin) ? skin : ('standard' as Skin),
    theme: params.get('appearance') ?? 'light',
    lang: params.get('lang') ?? 'zh-CN',
  })
  const [plan, setPlan] = useState<ManagerResetPreview | null>(null)
  useEffect(() => {
    void original('managers.reset.preview', {
      deviceId: 'local',
      managerId: initial.id,
      target: { harness: 'codex', model: null, effort: null, permission: ':danger-full-access' },
    }).then(setPlan)
  }, [])
  Object.assign(window, {
    __litchLook: {
      set: (patch: Partial<typeof look>) => setLook((value) => ({ ...value, ...patch })),
    },
  })
  if (!plan) return null
  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <I18nContext.Provider value={translator(look.lang === 'en' ? 'en' : 'zh-CN')}>
          <ServicesProvider booted={booted} prefs={loadPrefs()} setPrefs={noop}>
            <ThemeContext.Provider value={makeTheme(look.skin, look.theme === 'dark')}>
              <ConsentPresentation>
                <NavigationContainer>
                  <Body phase={params.get('phase') ?? 'settings'} plan={plan} />
                </NavigationContainer>
              </ConsentPresentation>
            </ThemeContext.Provider>
          </ServicesProvider>
        </I18nContext.Provider>
      </KeyboardProvider>
    </SafeAreaProvider>
  )
}
