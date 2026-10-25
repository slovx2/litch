// 对话里的一张 mermaid 卡片：固定高度，里面是整张图等比缩小后的缩略图（宽度能撑满就撑满）。点图全屏看（MermaidViewer.tsx）。
// 块头是“图 / 源码”切换和复制；画不出来（语法错）时块头写原因，下面照源码显示。
// 缩略图是藏着的画图页画好的 PNG（drawer.ts、MermaidHost.tsx），卡片里只有原生的 Image：滚动时不碰 WebView。
// 进了屏幕（in-view.ts）才去要，画过的直接从缓存拿。行会被列表回收给别的内容，状态都对着原文记，原文换了就作废。
import * as Clipboard from 'expo-clipboard'
import { memo, useEffect, useRef, useState } from 'react'
import {
  Image,
  type LayoutChangeEvent,
  PixelRatio,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { useTranscript } from '../context'
import { type DrawBox, type Drawing, drawer, drawKey, TIMED_OUT } from './drawer'
import { useInView } from './in-view'
import { mermaidLook } from './look'

/** 卡片里放图那一块的高度 */
export const FIGURE_HEIGHT = 200
/** 图四周留的边 */
const INSET = 8
const BORDER = 1
/** 小图最多放大几倍：两个节点的图不至于撑成满屏的大字 */
const MAX_UPSCALE = 1.25

/** 上一次量到的卡片宽度：滑回来的卡片第一帧就能对上缓存，不用等量完 */
let lastWidth = 0

export const MermaidCard = memo(function MermaidCard({ source }: { source: string }) {
  const theme = useTheme()
  const { c, font, radius } = theme
  const t = useT()
  const { viewMermaid } = useTranscript()
  const card = useRef<View>(null)
  const { seen: inView, measure } = useInView(card, source)
  const look = mermaidLook(theme)
  const [width, setWidth] = useState(lastWidth)
  const box: DrawBox | null =
    width > BORDER * 2 + INSET * 2
      ? {
          width: Math.round(width - BORDER * 2 - INSET * 2),
          height: FIGURE_HEIGHT - INSET * 2,
          scale: PixelRatio.get(),
          max: MAX_UPSCALE,
        }
      : null
  const key = box ? drawKey(look.key, box, source) : null
  const [got, setGot] = useState<{ key: string; drawing: Drawing } | null>(null)
  const drawing = (key && drawer.peek(key)) || (got && got.key === key ? got.drawing : null)

  useEffect(() => {
    if (!key) return
    return drawer.watch(key, (next) => setGot({ key, drawing: next }))
  }, [key])
  // box 由 key 定
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上
  useEffect(() => {
    if (!key || !box || !inView || drawer.peek(key)) return
    return drawer.request({ key, source, config: look.config, box })
  }, [key, inView, source, look])

  // 切到源码、刚复制过：都对着这一份原文记，行被回收给别的图时不带过去
  const [raw, setRaw] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = () => {
    void Clipboard.setStringAsync(source).then(() => {
      setCopied(source)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(null), 1500)
    })
  }

  const onLayout = (event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width)
    lastWidth = next
    if (next !== width) setWidth(next)
    measure()
  }

  const error = drawing && 'error' in drawing ? drawing.error : null
  const figure = drawing && 'svg' in drawing ? drawing : null
  const showSource = error !== null || raw === source
  const meta = { color: c.ink2, fontSize: font.size.meta }
  const tab = (on: boolean) => [
    styles.tab,
    { borderRadius: radius.s },
    on ? { backgroundColor: c.selBg } : null,
  ]
  const tabText = (on: boolean) => [meta, on ? { color: c.selFg } : null]

  return (
    <View
      ref={card}
      onLayout={onLayout}
      style={[
        styles.card,
        { backgroundColor: c.sunken, borderColor: c.line1, borderRadius: radius.m },
      ]}
      testID="mermaid-card"
    >
      <View style={[styles.head, { borderBottomColor: c.line1 }]}>
        {error !== null ? (
          <Text style={[meta, styles.reason, { color: c.err }]} numberOfLines={1}>
            {t('mermaid.failed', {
              reason: error === TIMED_OUT ? t('detail.mermaid.timeout') : error,
            })}
          </Text>
        ) : (
          <View style={styles.tabs} accessibilityRole="tablist">
            <Pressable
              onPress={() => setRaw(null)}
              style={tab(!showSource)}
              accessibilityRole="tab"
              accessibilityState={{ selected: !showSource }}
              testID="mermaid-card:figure"
            >
              <Text style={tabText(!showSource)}>{t('mermaid.figure')}</Text>
            </Pressable>
            <Pressable
              onPress={() => setRaw(source)}
              style={tab(showSource)}
              accessibilityRole="tab"
              accessibilityState={{ selected: showSource }}
              testID="mermaid-card:source"
            >
              <Text style={tabText(showSource)}>{t('mermaid.source')}</Text>
            </Pressable>
          </View>
        )}
        <Pressable onPress={copy} style={styles.tab} hitSlop={8} testID="mermaid-card:copy">
          <Text style={meta}>{t(copied === source ? 'code.copied' : 'code.copy')}</Text>
        </Pressable>
      </View>
      {showSource ? (
        <SourceText source={source} />
      ) : (
        <Pressable
          disabled={!figure}
          onPress={() => figure && viewMermaid(source, figure.svg)}
          accessibilityRole="imagebutton"
          accessibilityLabel={t('mermaid.label')}
          accessibilityHint={t('detail.mermaid.open')}
          style={styles.figure}
          testID="mermaid-card:open"
        >
          {figure ? (
            <Image
              source={{ uri: figure.png }}
              style={{ width: figure.width, height: figure.height }}
              fadeDuration={0}
              testID="mermaid-card:image"
            />
          ) : (
            <Text style={[meta, { color: c.ink3 }]}>{t('detail.mermaid.drawing')}</Text>
          )}
        </Pressable>
      )}
    </View>
  )
})

/** 照源码显示：等宽字，长行横着滚。对话里不可选字（同别的块），全屏页里可选 */
export function SourceText({ source, selectable }: { source: string; selectable?: boolean }) {
  const { c, font } = useTheme()
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <Text
        style={[styles.source, { color: c.ink, fontFamily: font.mono }]}
        selectable={selectable}
        testID="mermaid-source"
      >
        {source}
      </Text>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  card: { borderWidth: BORDER, overflow: 'hidden', marginVertical: 4 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 6,
    minHeight: 34,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tabs: { flexDirection: 'row', gap: 2 },
  tab: { paddingHorizontal: 8, paddingVertical: 4 },
  reason: { flex: 1, paddingHorizontal: 4 },
  figure: {
    height: FIGURE_HEIGHT,
    padding: INSET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  source: { fontSize: 13, lineHeight: 19, padding: 10 },
})
