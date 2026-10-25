// 全屏看一张 mermaid 图：盖住整个屏幕，上面一排是关闭、“图 / 源码”切换、复制；系统返回键关掉。
// 图是画图页画好的 SVG，放进全屏页（src/web/mermaid-viewer.js）里，双指缩放、拖动、双击复原都在页面里做，矢量放大也清楚。
import * as Clipboard from 'expo-clipboard'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { WebView } from 'react-native-webview'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { VIEWER_HTML } from '../../web/mermaid-html.generated'
import { SourceText } from './MermaidCard'

export interface MermaidShown {
  source: string
  svg: string
}

export function MermaidViewer({ shown, onClose }: { shown: MermaidShown | null; onClose(): void }) {
  return (
    <Modal
      visible={shown !== null}
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      {shown ? <Viewer shown={shown} onClose={onClose} /> : null}
    </Modal>
  )
}

function Viewer({ shown, onClose }: { shown: MermaidShown; onClose(): void }) {
  const { c, font, radius } = useTheme()
  const t = useT()
  const insets = useSafeAreaInsets()
  const [raw, setRaw] = useState(false)
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = () => {
    void Clipboard.setStringAsync(shown.source).then(() => {
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    })
  }
  // 图和底色直接写进页面，放在页面脚本前面（安卓上 injectedJavaScriptBeforeContentLoaded 可能晚于页面自己的脚本）。
  // 写进 <script> 的 JSON 把 < 转义掉，图里的字收不住这一段
  const html = useMemo(() => {
    const config = JSON.stringify({ svg: shown.svg, background: c.sunken }).replaceAll(
      '<',
      '\\u003c',
    )
    return VIEWER_HTML.replace('<body>', `<body><script>window.__litchConfig=${config}</script>`)
  }, [shown.svg, c.sunken])
  const meta = { color: c.ink2, fontSize: font.size.meta }
  const tab = (on: boolean) => [
    styles.button,
    { borderRadius: radius.s },
    on ? { backgroundColor: c.selBg } : null,
  ]
  const tabText = (on: boolean) => [meta, on ? { color: c.selFg } : null]
  return (
    <View style={[styles.page, { backgroundColor: c.sunken }]} testID="mermaid-viewer">
      <View
        style={[
          styles.bar,
          { paddingTop: insets.top + 4, backgroundColor: c.panel, borderBottomColor: c.line2 },
        ]}
      >
        <Pressable
          onPress={onClose}
          hitSlop={8}
          style={styles.button}
          accessibilityRole="button"
          accessibilityLabel={t('viewer.close')}
          testID="mermaid-viewer:close"
        >
          <Text style={[styles.close, { color: c.ink }]}>✕</Text>
        </Pressable>
        <View style={styles.tabs} accessibilityRole="tablist">
          <Pressable
            onPress={() => setRaw(false)}
            style={tab(!raw)}
            accessibilityRole="tab"
            accessibilityState={{ selected: !raw }}
            testID="mermaid-viewer:figure"
          >
            <Text style={tabText(!raw)}>{t('mermaid.figure')}</Text>
          </Pressable>
          <Pressable
            onPress={() => setRaw(true)}
            style={tab(raw)}
            accessibilityRole="tab"
            accessibilityState={{ selected: raw }}
            testID="mermaid-viewer:source"
          >
            <Text style={tabText(raw)}>{t('mermaid.source')}</Text>
          </Pressable>
        </View>
        <Pressable onPress={copy} hitSlop={8} style={styles.button} testID="mermaid-viewer:copy">
          <Text style={meta}>{t(copied ? 'code.copied' : 'code.copy')}</Text>
        </Pressable>
      </View>
      {raw ? (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>
          <SourceText source={shown.source} selectable />
        </ScrollView>
      ) : (
        <View style={styles.page}>
          <WebView
            source={{ html }}
            originWhitelist={['*']}
            javaScriptEnabled
            textZoom={100}
            overScrollMode="never"
            setBuiltInZoomControls={false}
            style={[styles.page, { backgroundColor: c.sunken }]}
            testID="mermaid-viewer:web"
          />
          <Text
            pointerEvents="none"
            style={[
              styles.hint,
              { color: c.ink3, fontSize: font.size.small, bottom: insets.bottom + 12 },
            ]}
          >
            {t('detail.mermaid.hint')}
          </Text>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingBottom: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tabs: { flexDirection: 'row', gap: 2 },
  button: { paddingHorizontal: 10, paddingVertical: 8, minWidth: 44, alignItems: 'center' },
  close: { fontSize: 18 },
  hint: { position: 'absolute', left: 16, right: 16, textAlign: 'center' },
})
