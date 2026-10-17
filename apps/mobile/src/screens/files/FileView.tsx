// 只读看一个文件：等宽、带行号、不折行（横着滑）。按行虚拟化，行高固定，几千行的文件也只画看得见的几十行；
// 一行太长只显示前面一截并说还有多少。按行切、切长行、字节数的写法用桌面的 packages/ui/src/files/lines.ts。
// 带了 line 的打开时滚到那一行并标出来。不按文字显示的文件（太大、不是文字、不在了）只说是哪一种。
import type { FileContent } from '@litch/core'
import { useCallback, useMemo, useState } from 'react'
import {
  FlatList,
  type LayoutChangeEvent,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { byteSize, cutLine, splitLines } from '../../../../../packages/ui/src/files/lines.ts'
import { useT } from '../../ui/i18n'
import { Empty } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'

const LINE_H = 18
const FONT = 12
/** 量字宽用的那串字有多长 */
const PROBE = 64
/** 定位到某一行时，它上面留几行 */
const ABOVE = 4

export function FileView({ content, line }: { content: FileContent; line?: number }) {
  const t = useT()
  if (content.kind === 'text') return <TextView content={content} line={line} />
  if (content.kind === 'tooLarge')
    return (
      <Empty
        title={t('files.view.tooLarge')}
        detail={t('files.view.tooLarge.note', {
          size: byteSize(content.bytes),
          limit: byteSize(content.limit),
        })}
      />
    )
  if (content.kind === 'binary')
    return (
      <Empty
        title={t(`files.view.group.${content.group}`)}
        detail={[
          t('files.view.binary.note'),
          content.bytes === null
            ? ''
            : t('files.view.binary.sized', { size: byteSize(content.bytes) }),
        ].join('')}
      />
    )
  if (content.kind === 'missing')
    return <Empty title={t('files.view.missing')} detail={t('files.view.missing.note')} />
  return <Empty title={t('files.view.failed')} />
}

interface Line {
  n: number
  text: string
  /** 截掉了多少个字 */
  cut: number
}

function TextView({
  content,
  line,
}: {
  content: Extract<FileContent, { kind: 'text' }>
  line?: number
}) {
  const theme = useTheme()
  const { c } = theme
  const t = useT()
  const { width: screen } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  // 等宽字一个多宽：先按字号估，量到了再换
  const [charW, setCharW] = useState(FONT * 0.6)
  const lines = useMemo(() => {
    return splitLines(content.text).map<Line>((raw, at) => {
      const { text, hidden } = cutLine(raw)
      return { n: at + 1, text, cut: hidden }
    })
  }, [content.text])
  const longest = useMemo(
    () =>
      lines.reduce((most, entry) => Math.max(most, entry.text.length + (entry.cut ? 40 : 0)), 0),
    [lines],
  )
  const gutter = String(lines.length).length * charW + 16
  const width = Math.max(screen, gutter + longest * charW + 24)
  const target = line && line >= 1 && line <= lines.length ? line : null
  const missed = line !== undefined && target === null

  const measure = (event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.width / PROBE
    if (measured > 0 && Math.abs(measured - charW) > 0.01) setCharW(measured)
  }

  const renderItem = useCallback(
    ({ item }: { item: Line }) => (
      <View
        style={[styles.line, item.n === target ? { backgroundColor: c.sel } : null]}
        testID={item.n === target ? 'files:target' : undefined}
      >
        <Text
          style={[
            styles.number,
            {
              width: gutter,
              color: c.ink3,
              fontFamily: theme.font.mono,
              borderRightColor: c.line1,
            },
          ]}
        >
          {item.n}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.code, { color: c.ink, fontFamily: theme.font.mono }]}
        >
          {item.text}
          {item.cut ? (
            <Text style={{ color: c.ink3 }}> {t('files.view.lineCut', { n: item.cut })}</Text>
          ) : null}
        </Text>
      </View>
    ),
    [c, gutter, target, theme.font.mono, t],
  )

  const facts = [
    t('files.view.lines', { n: lines.length }),
    byteSize(content.bytes),
    content.language ?? t('files.view.plain'),
    t('files.view.readonly'),
  ]
  return (
    <View style={[styles.wrap, { backgroundColor: c.sunken }]}>
      <View style={[styles.facts, { backgroundColor: c.panel, borderBottomColor: c.line1 }]}>
        <Text style={[styles.factText, { color: c.ink3, fontFamily: theme.font.mono }]}>
          {facts.join(' · ')}
        </Text>
        {content.lossy ? (
          <Text style={[styles.factText, { color: c.wait }]}>{t('files.view.lossy.note')}</Text>
        ) : null}
        {missed ? (
          <Text style={[styles.factText, { color: c.wait }]}>
            {t('sessions.files.notFound', { n: lines.length })}
          </Text>
        ) : null}
      </View>
      {/* 量等宽字的宽度：不显示 */}
      <View style={styles.probe} pointerEvents="none">
        <Text onLayout={measure} style={{ fontFamily: theme.font.mono, fontSize: FONT }}>
          {'0'.repeat(PROBE)}
        </Text>
      </View>
      <ScrollView horizontal bounces={false} testID="files:hscroll">
        <FlatList
          style={{ width }}
          data={lines}
          keyExtractor={(entry) => String(entry.n)}
          renderItem={renderItem}
          getItemLayout={(_, index) => ({ length: LINE_H, offset: LINE_H * index, index })}
          initialScrollIndex={target ? Math.max(0, target - 1 - ABOVE) : undefined}
          initialNumToRender={60}
          windowSize={11}
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          testID="files:text"
        />
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  facts: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    gap: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  factText: { fontSize: 11 },
  probe: { position: 'absolute', opacity: 0, flexDirection: 'row', top: 0, left: 0 },
  line: { height: LINE_H, flexDirection: 'row', alignItems: 'center' },
  number: {
    height: LINE_H,
    lineHeight: LINE_H,
    fontSize: FONT,
    textAlign: 'right',
    paddingRight: 6,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  code: { height: LINE_H, lineHeight: LINE_H, fontSize: FONT, paddingLeft: 8 },
})
