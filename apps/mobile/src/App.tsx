// 原型的入口：取连接配置、装核心、在首页和详情之间切换。没有路由库：只有三屏，用状态切。
// 测试脚本可以用链接直接驱动（adb shell am start -a android.intent.action.VIEW -d '<链接>'）：
//   litchproto://new?prompt=长回答&variant=A&markers=1   新建会话并打开
//   litchproto://open?session=<标识>&variant=B             打开已有的会话（session=last 是这次启动里最近新建的）
//   litchproto://send?text=短回答                          往最近新建的会话里再发一句
//   litchproto://home                                      回首页
//   litchproto://bench                                     WebView 吞吐测试
import { useCallback, useEffect, useRef, useState } from 'react'
import { Linking, StyleSheet, Text, View } from 'react-native'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { WebViewBench } from './bench/WebViewBench'
import { experiment } from './experiment'
import { markOpen, startProbe, stopProbe } from './probe'
import { type Booted, bootCore, DEVICE_ID, fetchDevConfig } from './core/boot'
import type { RemoteConfig } from './core/transport'
import { DetailScreen } from './detail/DetailScreen'
import { colors } from './detail/theme'
import type { Variant } from './detail/Transcript'
import { HomeScreen, titleOf } from './HomeScreen'

const CONFIG_PORT = 8765

type Screen =
  | { kind: 'home' }
  | { kind: 'detail'; sessionId: string; title: string }
  | { kind: 'bench' }

interface Booting {
  booted: Booted | null
  config: (RemoteConfig & { work?: string }) | null
  error: string | null
}

function useBoot(): Booting {
  const [state, setState] = useState<Booting>({ booted: null, config: null, error: null })
  useEffect(() => {
    let booted: Booted | null = null
    let cancelled = false
    const attempt = async (left: number) => {
      try {
        const config = await fetchDevConfig(CONFIG_PORT)
        if (cancelled) return
        booted = bootCore(config)
        setState({ booted, config, error: null })
      } catch (error) {
        if (cancelled) return
        setState({ booted: null, config: null, error: String(error) })
        if (left > 0) setTimeout(() => void attempt(left - 1), 1500)
      }
    }
    void attempt(20)
    return () => {
      cancelled = true
      booted?.stop()
    }
  }, [])
  return state
}

export default function App() {
  const { booted, config, error } = useBoot()
  const [screen, setScreen] = useState<Screen>({ kind: 'home' })
  const [variant, setVariant] = useState<Variant>('A')
  const [markers, setMarkers] = useState(process.env.EXPO_PUBLIC_MARKERS === '1')
  const lastCreated = useRef<string | null>(null)

  const create = useCallback(
    async (prompt: string) => {
      if (!booted) return
      const { sessionId } = await booted.channel.command('session.create', {
        deviceId: DEVICE_ID,
        cwd: config?.work ?? null,
        text: prompt,
      })
      lastCreated.current = sessionId
      setScreen({ kind: 'detail', sessionId, title: prompt })
    },
    [booted, config],
  )

  useEffect(() => {
    if (!booted) return
    const handle = (url: string | null) => {
      if (!url) return
      const parsed = new URL(url)
      const params = parsed.searchParams
      const v = params.get('variant')
      if (v === 'A' || v === 'B') setVariant(v)
      if (params.has('markers')) setMarkers(params.get('markers') === '1')
      const render = params.get('render')
      if (render === 'md' || render === 'plain') experiment.render = render
      const seal = Number(params.get('seal'))
      if (seal > 0) experiment.seal = seal
      if (params.has('pace')) experiment.pace = Math.max(0, Number(params.get('pace')) || 0)
      if (params.has('freeze')) experiment.freeze = params.get('freeze') === '1'
      const tail = params.get('tail')
      if (tail === 'open' || tail === 'whole') experiment.tail = tail
      const keyboard = params.get('keyboard')
      if (keyboard === 'sticky' || keyboard === 'chat') experiment.keyboard = keyboard
      if (params.has('probe')) (params.get('probe') === '1' ? startProbe : stopProbe)()
      switch (parsed.hostname) {
        case 'new':
          void create(params.get('prompt') ?? '长回答')
          return
        case 'open': {
          // session=last：这次启动里最近新建的那个会话（测量脚本先建好再进出它）
          const asked = params.get('session')
          const sessionId = asked === 'last' ? lastCreated.current : asked
          if (!sessionId) return
          markOpen()
          setScreen({ kind: 'detail', sessionId, title: params.get('title') ?? sessionId })
          return
        }
        case 'send': {
          // 往正打开的（或最近新建的）会话里再发一句：测量脚本造多轮的历史用
          const sessionId = lastCreated.current
          if (sessionId) {
            void booted.channel.command('session.send', {
              deviceId: DEVICE_ID,
              sessionId,
              text: params.get('text') ?? '短回答',
            })
          }
          return
        }
        case 'bench':
          setScreen({ kind: 'bench' })
          return
        default:
          setScreen({ kind: 'home' })
      }
    }
    void Linking.getInitialURL().then(handle)
    const subscription = Linking.addEventListener('url', (event) => handle(event.url))
    return () => subscription.remove()
  }, [booted, create])

  let body: React.ReactNode
  if (!booted) {
    body = (
      <View style={styles.center}>
        <Text style={styles.wait}>{error ? `等连接配置：${error}` : '启动中…'}</Text>
      </View>
    )
  } else if (screen.kind === 'detail') {
    body = (
      <DetailScreen
        channel={booted.channel}
        sessionId={screen.sessionId}
        title={screen.title}
        variant={variant}
        markers={markers}
        onBack={() => setScreen({ kind: 'home' })}
        onVariant={setVariant}
      />
    )
  } else if (screen.kind === 'bench') {
    body = <WebViewBench onBack={() => setScreen({ kind: 'home' })} />
  } else {
    body = (
      <HomeScreen
        channel={booted.channel}
        onOpen={(session) => setScreen({ kind: 'detail', sessionId: session.id, title: titleOf(session.title) })}
        onCreate={(prompt) => void create(prompt)}
        onBench={() => setScreen({ kind: 'bench' })}
      />
    )
  }
  return (
    <SafeAreaProvider>
      <KeyboardProvider>{body}</KeyboardProvider>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  wait: { color: colors.muted, fontSize: 14, padding: 24 },
})
