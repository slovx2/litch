// 画图的 WebView：挂在应用根上、看不见、不接触摸。有图要画时才开，闲了一分钟撤掉（排队和缓存在 drawer.ts）。
// 页面是本地打包的 mermaid（src/web/mermaid-page.js 加 mermaid 的单文件构建），不从网络加载。
// 对话里的卡片只显示它画好的 PNG：滚动时屏幕上没有 WebView。
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { StyleSheet, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { MERMAID_HTML } from '../../web/mermaid-html.generated'
import { drawer, type FromPage, type ToPage } from './drawer'

const script = (message: ToPage): string => `window.__litch(${JSON.stringify(message)});true;`

export function MermaidHost() {
  const state = useSyncExternalStore(drawer.subscribeHost, drawer.hostState)
  if (!state.wanted) return null
  return <Page key={state.generation} />
}

function Page() {
  const view = useRef<WebView>(null)
  // 页面撤掉、重开时告诉排队的那一头
  useEffect(() => () => drawer.pageGone(), [])
  const onMessage = (event: WebViewMessageEvent) => {
    let message: FromPage
    try {
      message = JSON.parse(event.nativeEvent.data) as FromPage
    } catch {
      return
    }
    if (message.t === 'ready')
      drawer.pageReady((next) => view.current?.injectJavaScript(script(next)))
    else if (message.t === 'error') console.warn(`LITCH_MERMAID_ERROR ${message.message}`)
    else drawer.receive(message)
  }
  return (
    <View
      style={styles.host}
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      <WebView
        ref={view}
        source={{ html: MERMAID_HTML }}
        originWhitelist={['*']}
        onMessage={onMessage}
        javaScriptEnabled
        // 渲染进程没了：正在画的那张放回去，重开一个接着画
        onContentProcessDidTerminate={() => drawer.pageCrashed()}
        onRenderProcessGone={() => drawer.pageCrashed()}
        textZoom={100}
        style={styles.web}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  // 留一块正常大小的视口：mermaid 量字、排版要用到页面的布局
  host: { position: 'absolute', left: 0, top: 0, width: 400, height: 400, opacity: 0 },
  web: { flex: 1, backgroundColor: 'transparent' },
})
