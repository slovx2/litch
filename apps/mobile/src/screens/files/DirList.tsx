// 一层目录：目录在前（对面已经排好），点目录进下一层、点文件打开看；长按复制路径。
// 隐藏的（名字以点开头）默认不显示；太多了对面只给前面一截，末尾说一句还有多少没显示。
import { type DirectoryView, type FileEntry, joinPath, relativeTo } from '@litch/core'
import * as Clipboard from 'expo-clipboard'
import { useCallback, useMemo, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useT } from '../../ui/i18n'
import { Empty } from '../../ui/kit/controls'
import { Sheet } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'

const ROW_H = 48

const GLYPH = { dir: '▸', file: '·', other: '~' } as const

export function DirList({
  view,
  root,
  showHidden,
  refreshing,
  onRefresh,
  onOpen,
}: {
  view: DirectoryView
  root: string
  showHidden: boolean
  refreshing: boolean
  onRefresh(): void
  onOpen(path: string): void
}) {
  const theme = useTheme()
  const { c } = theme
  const t = useT()
  const insets = useSafeAreaInsets()
  const [held, setHeld] = useState<string | null>(null)
  const entries = useMemo(
    () => (showHidden ? view.entries : view.entries.filter((entry) => !entry.name.startsWith('.'))),
    [view, showHidden],
  )
  const hidden = view.total - view.entries.length

  const renderItem = useCallback(
    ({ item }: { item: FileEntry }) => {
      const path = joinPath(view.path, item.name)
      return (
        <Pressable
          accessibilityRole="button"
          testID={`file:${item.name}`}
          onPress={() => onOpen(path)}
          onLongPress={() => setHeld(path)}
          style={({ pressed }) => [
            styles.row,
            { borderBottomColor: c.line1, backgroundColor: pressed ? c.press : c.panel },
          ]}
        >
          <Text style={[styles.glyph, { color: c.ink3, fontFamily: theme.font.mono }]}>
            {GLYPH[item.kind]}
          </Text>
          <Text
            numberOfLines={1}
            style={[
              styles.name,
              {
                color: item.name.startsWith('.') ? c.ink2 : c.ink,
                fontFamily: theme.font.mono,
                fontWeight: item.kind === 'dir' ? '600' : '400',
              },
            ]}
          >
            {item.kind === 'dir' ? `${item.name}/` : item.name}
          </Text>
        </Pressable>
      )
    },
    [view.path, onOpen, c, theme.font.mono],
  )

  const copy = (text: string) => void Clipboard.setStringAsync(text)
  return (
    <>
      <FlatList
        data={entries}
        keyExtractor={(entry) => entry.name}
        renderItem={renderItem}
        getItemLayout={(_, index) => ({ length: ROW_H, offset: ROW_H * index, index })}
        refreshing={refreshing}
        onRefresh={onRefresh}
        ListEmptyComponent={<Empty title={t('files.tree.empty')} />}
        ListFooterComponent={
          hidden > 0 ? (
            <Text style={[styles.note, { color: c.ink3 }]}>
              {t('files.tree.truncated', { n: hidden })}
            </Text>
          ) : null
        }
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
        testID="files:list"
      />
      <Sheet
        visible={held !== null}
        title={held ?? undefined}
        onClose={() => setHeld(null)}
        actions={
          held
            ? [
                { label: t('files.action.copyFull'), onPress: () => copy(held) },
                {
                  label: t('files.action.copyRelative'),
                  onPress: () => copy(relativeTo(root, held)),
                },
              ]
            : []
        }
      />
    </>
  )
}

const styles = StyleSheet.create({
  row: {
    height: ROW_H,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  glyph: { width: 14, fontSize: 13, textAlign: 'center' },
  name: { flex: 1, fontSize: 14 },
  note: { paddingHorizontal: 16, paddingVertical: 14, fontSize: 13 },
})
