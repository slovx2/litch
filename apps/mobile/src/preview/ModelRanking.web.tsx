// 预览专用：正式的模型等级排序（手机）和越级提示，对着模拟核心；排序的读写换成预览场景的数据
// （与桌面夹具同一份，packages/ui/test/fixtures/model-ranking-scenes.ts）。地址参数 rank=off|on|unranked|partial|limit。
import type { CoreChannel, DeviceView, ModelRankingSnapshot } from '@litch/core'
import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { useEffect, useMemo, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import {
  limitScene,
  type RankingScene,
  rankingScene,
  SCENE_HARNESSES,
} from '../../../../packages/ui/test/fixtures/model-ranking-scenes.ts'
import { ModelLimitNotice } from '../detail/proposals/ModelLimitNotice'
import { ModelRanking } from '../screens/devices/ModelRanking'
import { type Booted, boot } from '../shell/boot'
import { loadPrefs, ServicesProvider } from '../shell/services'
import { I18nContext, translator } from '../ui/i18n'
import { makeTheme, SKINS, type Skin, ThemeContext, useTheme } from '../ui/theme'

const Stack = createNativeStackNavigator()
const noop = () => {}

/** 模拟核心的通道，排序的三条命令换成场景数据 */
function rankingChannel(channel: CoreChannel, scene: RankingScene): CoreChannel {
  let snapshot: ModelRankingSnapshot = rankingScene(scene)
  const command = async (name: string, params: Record<string, unknown>) => {
    if (name === 'device.modelRanking.write')
      snapshot = {
        ...snapshot,
        ...(params as Partial<ModelRankingSnapshot>),
        mode: 'custom',
        revision: snapshot.revision + 1,
      }
    else if (name === 'device.modelRanking.reset')
      snapshot = { ...rankingScene('off'), revision: snapshot.revision + 1 }
    else if (name !== 'device.modelRanking.read')
      return (channel.command as (n: string, p: unknown) => Promise<unknown>)(name, params)
    return snapshot
  }
  return new Proxy(channel, {
    get(target, key) {
      if (key === 'command') return command
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

const device = {
  id: 'local',
  name: 'local',
  connection: 'online',
  harnesses: SCENE_HARNESSES.map((entry) => ({ ...entry, reason: null, detail: null })),
  modelRanking: true,
} as unknown as DeviceView

function Body({ scene }: { scene: RankingScene | 'limit' }) {
  const { c } = useTheme()
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.win }}>
      {scene === 'limit' ? (
        <View style={{ padding: 16, gap: 16 }}>
          {(['exceeded', 'unranked'] as const).map((kind) => (
            <ModelLimitNotice key={kind} limit={limitScene(kind)} busy={false} onUseModel={noop} />
          ))}
        </View>
      ) : (
        <ModelRanking device={device} reveal />
      )}
    </ScrollView>
  )
}

export function ModelRankingPreview({ params }: { params: URLSearchParams }) {
  const initialSkin = params.get('skin') as Skin
  const scene = (params.get('rank') ?? 'off') as RankingScene | 'limit'
  const [look, setLook] = useState({
    skin: SKINS.includes(initialSkin) ? initialSkin : 'standard',
    theme: params.get('appearance') ?? 'light',
    lang: params.get('lang') ?? 'zh-CN',
  })
  const [booted, setBooted] = useState<Booted | null>(null)
  useEffect(() => {
    let stopped = false
    let core: Booted | null = null
    void boot('mock', 'zh-CN').then((value) => {
      core = value
      if (stopped) value.stop()
      else setBooted(value)
    })
    return () => {
      stopped = true
      core?.stop()
    }
  }, [])
  Object.assign(window, {
    __litchLook: {
      set: (patch: Partial<typeof look>) => setLook((current) => ({ ...current, ...patch })),
    },
  })
  const wrapped = useMemo(
    () =>
      booted
        ? { ...booted, channel: rankingChannel(booted.channel, scene === 'limit' ? 'off' : scene) }
        : null,
    [booted, scene],
  )
  if (!wrapped) return null
  return (
    <SafeAreaProvider>
      <I18nContext.Provider value={translator(look.lang === 'en' ? 'en' : 'zh-CN')}>
        <ServicesProvider booted={wrapped} prefs={loadPrefs()} setPrefs={noop}>
          <ThemeContext.Provider value={makeTheme(look.skin, look.theme === 'dark')}>
            <NavigationContainer>
              <Stack.Navigator screenOptions={{ headerShown: false }}>
                <Stack.Screen name="Preview">{() => <Body scene={scene} />}</Stack.Screen>
              </Stack.Navigator>
            </NavigationContainer>
          </ThemeContext.Provider>
        </ServicesProvider>
      </I18nContext.Provider>
    </SafeAreaProvider>
  )
}
