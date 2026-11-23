// 正式设备管理列表，对着隔离核心验证启动中、失败和停止状态的重启入口。
import { connectChannel, createMockCore, createPortPair, serveChannel } from '@litch/core'
import { NavigationContainer } from '@react-navigation/native'
import { useState } from 'react'
import { ScrollView, Text } from 'react-native'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import {
  recoveryChannel,
  recoveryDevice,
  recoveryHarnesses,
} from '../../../../packages/ui/test/fixtures/harness-recovery.ts'
import { ConsentPresentation } from '../privacy/ConsentPresentation'
import { ManageSection } from '../screens/devices/ManageSection'
import { clock } from '../shell/boot'
import { loadPrefs, ServicesProvider } from '../shell/services'
import { I18nContext, translator } from '../ui/i18n'
import { makeTheme, ThemeContext } from '../ui/theme'

const core = createMockCore({ clock, lang: 'zh-CN' })
const [client, server] = createPortPair()
serveChannel(server, core, { clock })
let restored = (_id: string) => {}
const fixture = recoveryChannel(connectChannel(client), (id) => restored(id))
const booted = { mode: 'mock' as const, work: null, channel: fixture.channel, stop() {} }
Object.assign(window, { __harnessRecovery: { calls: fixture.calls } })
const noop = () => {}

export function HarnessRecoveryPreview({ params }: { params: URLSearchParams }) {
  const [harnesses, setHarnesses] = useState(recoveryHarnesses)
  restored = (id) =>
    setHarnesses((rows) =>
      rows.map((row) =>
        row.id === id ? { ...row, state: 'ready', down: null, detail: null } : row,
      ),
    )
  const device = recoveryDevice(params.get('device') ?? 'local', harnesses)
  const theme = makeTheme('standard', params.get('appearance') === 'dark')
  return (
    <SafeAreaProvider>
      <I18nContext.Provider value={translator('zh-CN')}>
        <ServicesProvider booted={booted} prefs={loadPrefs()} setPrefs={noop}>
          <ThemeContext.Provider value={theme}>
            <NavigationContainer>
              <KeyboardProvider>
                <ConsentPresentation>
                  <ScrollView style={{ flex: 1, backgroundColor: theme.c.win }}>
                    <Text style={{ color: theme.c.ink, fontSize: 24, padding: 16 }}>
                      {device.id === 'local' ? '本机' : '隔离远程设备'}
                    </Text>
                    <ManageSection device={device} />
                  </ScrollView>
                </ConsentPresentation>
              </KeyboardProvider>
            </NavigationContainer>
          </ThemeContext.Provider>
        </ServicesProvider>
      </I18nContext.Provider>
    </SafeAreaProvider>
  )
}
