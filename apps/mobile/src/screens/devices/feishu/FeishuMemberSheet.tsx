// 叫醒名单的成员选择单：从底下升起，顶上筛选框和“重新读取成员”，逐个勾选（点了不收起），
// 到上限后没勾的不能再勾。成员由群设置页读好传进来；已选但不在成员里的排最前，标“不在群成员中”。
import { useEffect, useState } from 'react'
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useKeyboardState } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  FEISHU_WAKERS_MAX,
  type FeishuMember,
  type FeishuPerson,
  memberChoices,
  toggleWaker,
} from '../../../../../../packages/ui/src/feishu/model.ts'
import { useT } from '../../../ui/i18n'
import { sectionFont } from '../../../ui/kit/controls'
import { IconButton } from '../../../ui/kit/Icon'
import { ModalKeyboardArea } from '../../../ui/kit/ModalKeyboardArea'
import { ChoiceMark } from '../../../ui/kit/marks'
import { useTheme } from '../../../ui/theme'

export function FeishuMemberSheet({
  visible,
  members,
  busy,
  error,
  wakers,
  onChange,
  onRefresh,
  onClose,
}: {
  visible: boolean
  /** 还没读到是 null */
  members: FeishuMember[] | null
  busy: boolean
  error: string
  wakers: FeishuPerson[]
  onChange(wakers: FeishuPerson[]): void
  onRefresh(): void
  onClose(): void
}) {
  const insets = useSafeAreaInsets()
  const keyboardShown = useKeyboardState((state) => state.isVisible)
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  const [query, setQuery] = useState('')
  useEffect(() => {
    if (visible) setQuery('')
  }, [visible])
  const choices = memberChoices(members, wakers, query)
  const chosen = new Set(wakers.map((one) => one.openId))
  const full = wakers.length >= FEISHU_WAKERS_MAX
  const meta = { color: c.ink3, fontSize: theme.font.size.meta }
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} testID="feishu:members:scrim" />
      <ModalKeyboardArea style={styles.bottom}>
        <View
          testID="feishu:members"
          style={[
            styles.sheet,
            {
              backgroundColor: c.raised,
              borderColor: c.line3,
              borderTopLeftRadius: theme.radius.l,
              borderTopRightRadius: theme.radius.l,
              paddingBottom: (keyboardShown ? 0 : insets.bottom) + 8,
            },
          ]}
        >
          <View style={styles.head}>
            <Text style={[styles.title, sectionFont(theme), { color: c.ink2 }]}>
              {t('feishu.chat.wakers')}
            </Text>
            <Text style={meta} testID="feishu:members:count">
              {t('feishu.chat.members.count', { count: wakers.length, max: FEISHU_WAKERS_MAX })}
            </Text>
            <IconButton
              icon="reload"
              label={t('feishu.chat.members.refresh')}
              busy={busy}
              testID="feishu:members:refresh"
              onPress={onRefresh}
            />
          </View>
          <TextInput
            accessibilityLabel={t('feishu.chat.members.search')}
            value={query}
            onChangeText={setQuery}
            placeholder={t('feishu.chat.members.search')}
            placeholderTextColor={c.ink3}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            testID="feishu:members:search"
            style={[
              styles.search,
              {
                color: c.ink,
                borderColor: c.line2,
                backgroundColor: c.panel,
                borderRadius: theme.radius.m,
                minHeight: theme.hit,
              },
            ]}
          />
          {full ? (
            <Text style={[styles.line, meta]}>
              {t('feishu.chat.members.full', { max: FEISHU_WAKERS_MAX })}
            </Text>
          ) : null}
          {error ? <Text style={[styles.line, { color: c.err }]}>{error}</Text> : null}
          {members === null && busy ? (
            <Text style={[styles.line, meta]}>{t('feishu.chat.members.loading')}</Text>
          ) : null}
          <FlatList
            style={styles.list}
            keyboardShouldPersistTaps="handled"
            data={choices}
            extraData={wakers}
            keyExtractor={(choice) => choice.person.openId}
            ListEmptyComponent={
              members !== null ? (
                <Text style={[styles.line, meta]}>
                  {query ? t('feishu.chat.members.noMatch') : t('feishu.chat.members.empty')}
                </Text>
              ) : null
            }
            renderItem={({ item: { person, listed } }) => {
              const checked = chosen.has(person.openId)
              const disabled = full && !checked
              return (
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked, disabled }}
                  disabled={disabled}
                  testID={`feishu:member:${person.openId}`}
                  onPress={() => onChange(toggleWaker(wakers, person))}
                  style={({ pressed }) => [
                    styles.row,
                    {
                      minHeight: theme.hit + 4,
                      borderTopColor: c.line1,
                      backgroundColor: pressed ? c.press : 'transparent',
                    },
                  ]}
                >
                  <ChoiceMark kind="check" state={checked ? 'on' : 'off'} />
                  <Text
                    numberOfLines={1}
                    style={[styles.name, { color: disabled ? c.ink3 : c.ink }]}
                  >
                    {person.name || person.openId}
                  </Text>
                  {listed ? null : <Text style={meta}>{t('feishu.chat.members.unlisted')}</Text>}
                </Pressable>
              )
            }}
          />
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            testID="feishu:members:done"
            style={[styles.row, { minHeight: theme.hit + 4, borderTopColor: c.line2 }]}
          >
            <Text style={[styles.name, { color: c.ink2 }]}>{t('feishu.close')}</Text>
          </Pressable>
        </View>
      </ModalKeyboardArea>
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
  sheet: { borderTopWidth: 1, maxHeight: '80%' },
  bottom: { justifyContent: 'flex-end' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 4 },
  title: { flex: 1, fontSize: 12, paddingVertical: 12 },
  search: { marginHorizontal: 16, marginBottom: 8, borderWidth: 1, paddingHorizontal: 12 },
  line: { paddingHorizontal: 16, paddingVertical: 6, lineHeight: 18 },
  list: { flexGrow: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  name: { flexShrink: 1, fontSize: 16 },
})
