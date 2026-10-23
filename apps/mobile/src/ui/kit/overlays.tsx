// 浮层：底部动作单（长按一行出来的菜单）、确认框、单行输入框（改名）。都用 RN 自带的 Modal，
// 系统返回键关掉。系统的 Alert 样式改不了、也不跟主题，所以不用它。
import { type ReactNode, useEffect, useState } from 'react'
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useT } from '../i18n'
import { useTheme } from '../theme'
import { Button, sectionFont } from './controls'

export interface SheetAction {
  label: string
  onPress(): void
  danger?: boolean
  testID?: string
}

/** 底部动作单。visible 为 false 时什么都不画 */
export function Sheet({
  visible,
  title,
  actions,
  onClose,
}: {
  visible: boolean
  title?: string
  actions: SheetAction[]
  onClose(): void
}) {
  const insets = useSafeAreaInsets()
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} testID="sheet:scrim" />
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: c.raised,
            borderColor: c.line3,
            borderTopLeftRadius: theme.radius.l,
            borderTopRightRadius: theme.radius.l,
            paddingBottom: insets.bottom + 8,
          },
        ]}
      >
        {title ? (
          <Text
            numberOfLines={2}
            style={[styles.sheetTitle, sectionFont(theme), { color: c.ink2 }]}
          >
            {title}
          </Text>
        ) : null}
        {actions.map((action) => (
          <Pressable
            key={action.label}
            accessibilityRole="button"
            testID={action.testID}
            onPress={() => {
              onClose()
              action.onPress()
            }}
            style={({ pressed }) => [
              styles.sheetRow,
              {
                minHeight: theme.hit + 4,
                borderTopColor: c.line1,
                backgroundColor: pressed ? c.press : 'transparent',
              },
            ]}
          >
            <Text style={[styles.sheetText, { color: action.danger ? c.err : c.ink }]}>
              {action.label}
            </Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          onPress={onClose}
          style={[styles.sheetRow, { minHeight: theme.hit + 4, borderTopColor: c.line2 }]}
        >
          <Text style={[styles.sheetText, { color: c.ink2 }]}>{t('app.cancel')}</Text>
        </Pressable>
      </View>
    </Modal>
  )
}

export function Dialog({
  visible,
  onClose,
  children,
}: {
  visible: boolean
  onClose(): void
  children: ReactNode
}) {
  const theme = useTheme()
  const { c } = theme
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.center}
      >
        <Pressable style={styles.scrim} onPress={onClose} />
        <View
          style={[
            styles.dialog,
            { backgroundColor: c.raised, borderColor: c.line3, borderRadius: theme.radius.l },
          ]}
        >
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

export function Confirm({
  visible,
  title,
  detail,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  visible: boolean
  title: string
  detail?: string
  confirmLabel: string
  danger?: boolean
  onConfirm(): void
  onClose(): void
}) {
  const theme = useTheme()
  const { c } = theme
  const t = useT()
  return (
    <Dialog visible={visible} onClose={onClose}>
      <Text style={[styles.dialogTitle, { color: c.ink, fontFamily: theme.font.ui }]}>{title}</Text>
      {detail ? <Text style={[styles.dialogDetail, { color: c.ink2 }]}>{detail}</Text> : null}
      <View style={styles.dialogButtons}>
        <Button kind="plain" label={t('app.cancel')} onPress={onClose} />
        <Button
          kind={danger ? 'danger' : 'solid'}
          label={confirmLabel}
          testID="confirm:ok"
          onPress={() => {
            onClose()
            onConfirm()
          }}
        />
      </View>
    </Dialog>
  )
}

/** 单行输入：改名之类。initial 是打开时的值；提交空的等于取消 */
export function Prompt({
  visible,
  title,
  initial,
  placeholder,
  submitLabel,
  onSubmit,
  onClose,
}: {
  visible: boolean
  title: string
  initial: string
  placeholder?: string
  submitLabel: string
  onSubmit(value: string): void
  onClose(): void
}) {
  const theme = useTheme()
  const { c } = theme
  const t = useT()
  const [value, setValue] = useState(initial)
  useEffect(() => {
    if (visible) setValue(initial)
  }, [visible, initial])
  const submit = () => {
    const trimmed = value.trim()
    onClose()
    if (trimmed && trimmed !== initial) onSubmit(trimmed)
  }
  return (
    <Dialog visible={visible} onClose={onClose}>
      <Text style={[styles.dialogTitle, { color: c.ink, fontFamily: theme.font.ui }]}>{title}</Text>
      <TextInput
        autoFocus
        value={value}
        onChangeText={setValue}
        placeholder={placeholder}
        placeholderTextColor={c.ink3}
        onSubmitEditing={submit}
        // 填的是路径、目录、名字：不许输入法自作主张改字、改大小写（Gboard 曾把 …/s/work 改成 …/s/works ）
        autoCorrect={false}
        autoCapitalize="none"
        spellCheck={false}
        testID="prompt:input"
        style={[
          styles.promptInput,
          {
            color: c.ink,
            borderColor: c.line2,
            borderRadius: theme.radius.m,
            backgroundColor: c.panel,
            minHeight: theme.hit,
          },
        ]}
      />
      <View style={styles.dialogButtons}>
        <Button kind="plain" label={t('app.cancel')} onPress={onClose} />
        <Button label={submitLabel} testID="prompt:ok" onPress={submit} />
      </View>
    </Dialog>
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
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopWidth: 1 },
  sheetTitle: { fontSize: 12, paddingHorizontal: 16, paddingVertical: 12 },
  sheetRow: {
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sheetText: { fontSize: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  dialog: { alignSelf: 'stretch', borderWidth: 1, padding: 20, gap: 14 },
  dialogTitle: { fontSize: 17, fontWeight: '600' },
  dialogDetail: { fontSize: 14, lineHeight: 20 },
  dialogButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  promptInput: { borderWidth: 1, paddingHorizontal: 12, fontSize: 15 },
})
