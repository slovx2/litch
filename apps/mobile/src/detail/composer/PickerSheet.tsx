// 从底下升起来的单选清单：设置条上的模型、强度、权限，新建会话页的 harness、项目都用它。
// 现在选着的那一项反白（复古皮肤的选中态）；不能选的灰着、带一句为什么。选项多的（模型）顶上有筛选框，
// 按空白拆开的每一段都要在标题、标识或说明里出现。从几个起出筛选框用桌面的 composer/picker-search.ts；
// 那边的 matchOptions 要的说明是 string | undefined，这里的选项说明可以是 null，筛的那几行留在这边。
import { useEffect, useMemo, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { SEARCH_FROM } from '../../../../../packages/ui/src/composer/picker-search.ts'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'

export interface PickerOption {
  id: string
  title: string
  note?: string | null
  disabled?: boolean
}

const matches = (option: PickerOption, words: string[]): boolean => {
  const hay = `${option.title}\n${option.id}\n${option.note ?? ''}`.toLowerCase()
  return words.every((word) => hay.includes(word))
}

export function PickerSheet({
  visible,
  title,
  value,
  options,
  search,
  onPick,
  onClose,
  testID,
}: {
  visible: boolean
  title: string
  value: string | null
  options: PickerOption[]
  /** 筛选框的提示语。不给就不出筛选框 */
  search?: string
  onPick(id: string): void
  onClose(): void
  testID?: string
}) {
  const insets = useSafeAreaInsets()
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  const [query, setQuery] = useState('')
  useEffect(() => {
    if (visible) setQuery('')
  }, [visible])
  const searchable = search !== undefined && options.length >= SEARCH_FROM
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return words.length ? options.filter((option) => matches(option, words)) : options
  }, [options, query])
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} testID="picker:scrim" />
      <View
        testID={testID}
        style={[
          styles.sheet,
          { backgroundColor: c.raised, borderColor: c.line3, paddingBottom: insets.bottom + 8 },
        ]}
      >
        <Text style={[styles.title, { color: c.ink2, fontFamily: theme.font.mono }]}>
          ## {title}
        </Text>
        {searchable ? (
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={search}
            placeholderTextColor={c.ink3}
            autoCapitalize="none"
            autoCorrect={false}
            testID="picker:search"
            style={[
              styles.search,
              {
                color: c.ink,
                borderColor: c.line2,
                backgroundColor: c.panel,
                minHeight: theme.hit,
              },
            ]}
          />
        ) : null}
        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          {shown.map((option) => {
            const selected = option.id === value
            const ink = selected ? c.invFg : option.disabled ? c.ink3 : c.ink
            return (
              <Pressable
                key={option.id}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled: !!option.disabled }}
                disabled={option.disabled}
                testID={`picker:option:${option.id}`}
                onPress={() => {
                  onClose()
                  if (!selected) onPick(option.id)
                }}
                style={({ pressed }) => [
                  styles.row,
                  {
                    minHeight: theme.hit + 4,
                    borderTopColor: c.line1,
                    backgroundColor: selected ? c.invBg : pressed ? c.press : 'transparent',
                  },
                ]}
              >
                <Text style={[styles.rowTitle, { color: ink }]}>
                  {selected ? '▸ ' : ''}
                  {option.title}
                </Text>
                {option.note ? (
                  <Text style={[styles.rowNote, { color: selected ? c.invFg : c.ink3 }]}>
                    {option.note}
                  </Text>
                ) : null}
              </Pressable>
            )
          })}
        </ScrollView>
        <Pressable
          accessibilityRole="button"
          onPress={onClose}
          style={[styles.row, { minHeight: theme.hit + 4, borderTopColor: c.line2 }]}
        >
          <Text style={[styles.rowTitle, { color: c.ink2 }]}>{t('app.cancel')}</Text>
        </Pressable>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: 1,
    maxHeight: '75%',
  },
  title: { fontSize: 12, paddingHorizontal: 16, paddingVertical: 12 },
  search: { marginHorizontal: 16, marginBottom: 8, borderWidth: 1, paddingHorizontal: 12 },
  list: { flexGrow: 0 },
  row: {
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowTitle: { fontSize: 16 },
  rowNote: { fontSize: 13, marginTop: 2 },
})
