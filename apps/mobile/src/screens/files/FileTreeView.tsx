// 手机文件树复用核心副本。目录链接只展开通向目标的分支，其他分支收起。
import { type FileRow, keys } from '@litch/core'
import { useIsFocused } from '@react-navigation/native'
import * as Clipboard from 'expo-clipboard'
import { useEffect, useRef, useState } from 'react'
import { FlatList, Pressable, Text, View } from 'react-native'
import { useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Caret, Icon } from '../../ui/kit/Icon'
import { useTheme } from '../../ui/theme'

const ROW_HEIGHT = 44
const EMPTY: FileRow[] = []

export function FileTreeView({
  deviceId,
  root,
  path,
  showHidden,
  onOpen,
}: {
  deviceId: string
  root: string
  path: string
  showHidden: boolean
  onOpen(path: string): void
}) {
  const { files } = useReplica()
  const focused = useIsFocused()
  const rows = useKey<FileRow[]>(keys.fileRows(deviceId, root)) ?? EMPTY
  const theme = useTheme()
  const t = useT()
  const list = useRef<FlatList<FileRow>>(null)
  const seek = useRef(path)
  const [refreshing, setRefreshing] = useState(false)
  useEffect(
    () => (focused ? files.open(deviceId, root) : undefined),
    [files, focused, deviceId, root],
  )
  useEffect(() => {
    files.setShowHidden(showHidden)
  }, [files, showHidden])
  useEffect(() => {
    seek.current = path
    void files.reveal(deviceId, root, path, { directory: true, collapseOthers: true })
  }, [files, deviceId, root, path])
  const locate = () => {
    const index = rows.findIndex((row) => row.path === seek.current)
    if (index < 0) return
    list.current?.scrollToIndex({ index, animated: false, viewPosition: 0.25 })
    seek.current = ''
  }
  return (
    <FlatList
      ref={list}
      data={rows}
      testID="files:list"
      keyExtractor={(row) => row.id}
      getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: index * ROW_HEIGHT, index })}
      onContentSizeChange={locate}
      onScrollToIndexFailed={() => {}}
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true)
        void files.refresh(deviceId, root).finally(() => setRefreshing(false))
      }}
      renderItem={({ item }) => {
        const selectable = item.kind === 'dir' || item.kind === 'file' || item.kind === 'other'
        const label = selectable
          ? item.name
          : t(
              item.kind === 'loading'
                ? 'files.tree.loading'
                : item.kind === 'failed'
                  ? 'files.tree.rootFailed'
                  : 'files.tree.empty',
            )
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{
              selected: item.path === path,
              ...(item.kind === 'dir' ? { expanded: !!item.expanded } : {}),
            }}
            testID={`file:${item.name}`}
            onLongPress={() => {
              void Clipboard.setStringAsync(item.path)
            }}
            onPress={() => {
              if (item.kind === 'dir') {
                if (item.expanded) files.collapse(deviceId, root, item.path)
                else files.expand(deviceId, root, item.path)
              } else if (selectable) onOpen(item.path)
              else if (item.kind === 'failed') void files.refresh(deviceId, root)
            }}
            style={({ pressed }) => ({
              height: ROW_HEIGHT,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingLeft: 16 + item.depth * 18,
              borderBottomWidth: 1,
              borderBottomColor: theme.c.line1,
              backgroundColor: pressed
                ? theme.c.press
                : item.path === path
                  ? theme.c.sel
                  : theme.c.panel,
            })}
          >
            {item.kind === 'dir' ? (
              <Caret open={!!item.expanded} size={12} />
            ) : item.kind === 'file' ? (
              <Icon name="file" size={13} color={theme.c.ink3} />
            ) : (
              <View style={{ width: 13 }} />
            )}
            <Text
              numberOfLines={1}
              style={{
                flex: 1,
                color: theme.c.ink,
                fontFamily: theme.font.mono,
                fontSize: theme.font.size.meta,
              }}
            >
              {label}
              {item.kind === 'dir' ? '/' : ''}
            </Text>
          </Pressable>
        )
      }}
    />
  )
}
