// 正式手机输入框、会话存储和单元格，经真实核心连接内存 JSON-RPC 对端。
import { connectChannel, createPortPair, serveChannel } from '@litch/core'
import { NavigationContainer } from '@react-navigation/native'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { composeStateFixture } from '../../../../packages/core/test/compose-state-fixture.mts'
import { SessionStore } from '../core/session-store'
import { Composer } from '../detail/Composer'
import { CompactionCell, MarkdownCell, StatusCell, UserCell } from '../detail/cells'
import { BackgroundContext, TranscriptContext } from '../detail/context'
import { GroupCell, GroupEndCell, ProcessCell, StepCell } from '../detail/steps'
import { ConsentPresentation } from '../privacy/ConsentPresentation'
import { type Booted, clock } from '../shell/boot'
import { loadPrefs, ServicesProvider } from '../shell/services'
import { I18nContext, translator } from '../ui/i18n'
import { makeTheme, ThemeContext } from '../ui/theme'

const noop = () => {}
function Content({ store }: { store: SessionStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  return (
    <View style={{ flex: 1, backgroundColor: '#17212b' }}>
      <Text style={{ color: '#ddd', padding: 16 }}>星云 · 手机输入验收</Text>
      <TranscriptContext.Provider
        value={{
          deviceId: 'local',
          sessionId: 'nebula',
          harness: 'Claude Code',
          scope: null,
          root: null,
          toggle: (key, turnId) => store.toggle(key, turnId),
          issues: null,
          openLink: noop,
          turnMenu: noop,
          copyMessage: noop,
          notify: noop,
          openDiff: noop,
          openSession: noop,
          viewImage: noop,
          viewMermaid: noop,
        }}
      >
        <BackgroundContext.Provider value={{ running: 0, wakesOnFinish: true, tasks: [] }}>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
            {[...snapshot.rows].reverse().map((row) => {
              if (row.type === 'user') return <UserCell key={row.key} row={row} />
              if (row.type === 'compaction') return <CompactionCell key={row.key} row={row} />
              if (row.type === 'md') return <MarkdownCell key={row.key} row={row} />
              if (row.type === 'status') return <StatusCell key={row.key} row={row} />
              if (row.type === 'group') return <GroupCell key={row.key} row={row} />
              if (row.type === 'groupEnd') return <GroupEndCell key={row.key} row={row} />
              if (row.type === 'process') return <ProcessCell key={row.key} row={row} />
              if (row.type === 'step') return <StepCell key={row.key} row={row} />
              return null
            })}
          </ScrollView>
        </BackgroundContext.Provider>
      </TranscriptContext.Provider>
      <Composer store={store} markers={false} />
    </View>
  )
}

export function ComposeStatePreview() {
  const [ready, setReady] = useState<{ booted: Booted; store: SessionStore } | null>(null)
  useEffect(() => {
    const { core, controls } = composeStateFixture(clock)
    const [client, server] = createPortPair()
    const stopServer = serveChannel(server, core, { clock })
    const channel = connectChannel(client)
    const store = new SessionStore(channel, 'local', 'nebula')
    store.start()
    const booted: Booted = { mode: 'mock', work: null, channel, stop: () => core.stop() }
    Object.assign(window, { __composeState: controls })
    setReady({ booted, store })
    return () => {
      store.stop()
      core.stop()
      stopServer()
    }
  }, [])
  if (!ready) return null
  return (
    <SafeAreaProvider>
      <I18nContext.Provider value={translator('zh-CN')}>
        <ServicesProvider
          booted={ready.booted}
          prefs={{ ...loadPrefs(), sendMode: 'now' }}
          setPrefs={noop}
        >
          <ThemeContext.Provider value={makeTheme('standard', true)}>
            <ConsentPresentation>
              <NavigationContainer>
                <Content store={ready.store} />
              </NavigationContainer>
            </ConsentPresentation>
          </ThemeContext.Provider>
        </ServicesProvider>
      </I18nContext.Provider>
    </SafeAreaProvider>
  )
}
