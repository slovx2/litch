// 详情设置里按类型画的控件（照桌面端的 HcControl）：开关、整数和小数、一行字、多行字、单选（可以手填的带候选）、
// 一列字（一行一项）、路径、密钥（只写不读）、JSON；这一版不认识的类型只读地摆出来。
// 草稿的形状和桌面一样（logic.ts 的 HcDraft：开关是真假，别的都是输入框里的原字），保存时才解析。
// 单选的选项少就排成一排小块，多了（模型列表）点开一张可以滚的清单选。自定义 provider 的表单也用它。
import type { HcSettingSpec, HcValue } from '@litch/core'
import { useState } from 'react'
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  HC_TYPES,
  type HcDraft,
  rawOf,
  secretSet,
} from '../../../../../../packages/ui/src/devices/hconfig/logic.ts'
import { useT } from '../../../ui/i18n'
import { Chip } from '../../../ui/kit/controls'
import { useTheme } from '../../../ui/theme'

/** 选项不超过这么多时排成一排小块，多了点开清单选 */
const INLINE_OPTIONS = 6

export interface HcControlProps {
  spec: HcSettingSpec
  /** 存着的值（没写过是 undefined，显示默认值） */
  stored: HcValue | undefined
  draft: HcDraft | undefined
  disabled: boolean
  wrong: boolean
  testID: string
  onDraft(draft: HcDraft): void
}

/** 控件里现在显示的原字：有草稿显示草稿；“恢复默认”显示默认值；否则存着的，没有就默认值 */
function shownRaw({ spec, stored, draft }: HcControlProps): boolean | string {
  if (draft?.kind === 'value') return draft.value
  if (draft?.kind === 'clear' || stored === undefined) return rawOf(spec, spec.default)
  return rawOf(spec, stored)
}

/** 宽的控件（多行字、列表、JSON、单选的小块）放在标题下面；开关放在标题右边 */
export const isInline = (spec: HcSettingSpec): boolean => spec.type === 'boolean'

export function HcControl(props: HcControlProps) {
  const { spec, stored, draft, disabled, wrong, testID, onDraft } = props
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  const [picking, setPicking] = useState(false)
  const off = disabled || spec.readOnly
  const raw = shownRaw(props)
  const set = (value: boolean | string) => onDraft({ kind: 'value', value })
  const inputStyle = (mono: boolean, multi = false) => [
    styles.input,
    {
      color: c.ink,
      backgroundColor: c.raised,
      borderColor: wrong ? c.err : c.line2,
      minHeight: theme.hit,
      opacity: off ? 0.6 : 1,
    },
    mono ? { fontFamily: theme.font.mono, fontSize: 13 } : null,
    multi ? styles.multi : null,
  ]
  const text = (options: {
    mono: boolean
    multi?: boolean
    keyboard?: 'number-pad' | 'decimal-pad'
    placeholder?: string
  }) => (
    <TextInput
      testID={testID}
      value={String(raw)}
      editable={!off}
      multiline={options.multi}
      keyboardType={options.keyboard ?? 'default'}
      placeholder={options.placeholder ?? spec.placeholder ?? undefined}
      placeholderTextColor={c.ink3}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      onChangeText={set}
      style={inputStyle(options.mono, options.multi)}
    />
  )

  if (!HC_TYPES.includes(spec.type)) {
    return (
      <View style={styles.unknown}>
        <Text style={[styles.mono, { color: c.ink2, fontFamily: theme.font.mono }]}>
          {stored === undefined ? t('manage.unknown.noValue') : JSON.stringify(stored)}
        </Text>
        <Text style={[styles.small, { color: c.ink3 }]}>
          {t('manage.unknown.note', { type: spec.type })}
        </Text>
      </View>
    )
  }
  switch (spec.type) {
    case 'boolean':
      return (
        <Switch
          testID={testID}
          accessibilityLabel={t.said(spec.title)}
          value={raw === true}
          disabled={off}
          onValueChange={(next) => set(next)}
          trackColor={{ true: c.accent, false: c.line2 }}
        />
      )
    case 'enum': {
      const value = String(raw)
      const picker = (
        <OptionPicker
          visible={picking}
          spec={spec}
          value={value}
          onPick={(next) => set(next)}
          onClose={() => setPicking(false)}
        />
      )
      if (spec.allowCustom) {
        // 可以手填清单里没有的（模型名）：输入框，旁边一个按钮点开候选清单
        return (
          <View style={styles.custom}>
            <View style={styles.grow}>{text({ mono: true })}</View>
            {spec.options.length > 0 ? (
              <Chip
                label={t('hcm.pick')}
                disabled={off}
                testID={`${testID}:pick`}
                onPress={() => setPicking(true)}
              />
            ) : null}
            {picker}
          </View>
        )
      }
      const listed = spec.options.some((option) => option.value === value)
      if (spec.options.length <= INLINE_OPTIONS) {
        return (
          <View style={styles.options}>
            {listed ? null : <Chip label={value || t('hc.value.unset')} on disabled />}
            {spec.options.map((option) => (
              <Chip
                key={option.value}
                label={t.said(option.title)}
                on={option.value === value}
                disabled={off}
                testID={`${testID}:${option.value}`}
                onPress={() => set(option.value)}
              />
            ))}
          </View>
        )
      }
      const current = spec.options.find((option) => option.value === value)
      return (
        <>
          <Pressable
            accessibilityRole="button"
            testID={testID}
            disabled={off}
            onPress={() => setPicking(true)}
            style={({ pressed }) => [
              ...inputStyle(false),
              styles.select,
              pressed ? { backgroundColor: c.press } : null,
            ]}
          >
            <Text numberOfLines={1} style={[styles.grow, { color: c.ink, fontSize: 15 }]}>
              {current ? t.said(current.title) : value || t('hc.value.unset')}
            </Text>
            <Text style={{ color: c.ink3 }}>▾</Text>
          </Pressable>
          {picker}
        </>
      )
    }
    case 'secret': {
      const has = secretSet(stored) && draft?.kind !== 'clear'
      return (
        <View style={styles.secret}>
          <Text style={[styles.small, { color: has ? c.ok : c.ink3 }]} testID={`${testID}:state`}>
            {t(
              draft?.kind === 'clear'
                ? 'manage.secret.clearing'
                : has
                  ? 'manage.secret.set'
                  : 'manage.secret.unset',
            )}
          </Text>
          <TextInput
            testID={testID}
            secureTextEntry
            value={draft?.kind === 'value' ? String(draft.value) : ''}
            editable={!off}
            placeholder={t(has ? 'manage.secret.replace' : 'manage.secret.enter')}
            placeholderTextColor={c.ink3}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={set}
            style={inputStyle(true)}
          />
        </View>
      )
    }
    case 'text':
      return text({ mono: false, multi: true })
    case 'stringList':
      return text({
        mono: true,
        multi: true,
        placeholder: spec.placeholder ?? t('hc.list.placeholder'),
      })
    case 'json':
      return text({ mono: true, multi: true })
    case 'integer':
      return text({ mono: true, keyboard: 'number-pad' })
    case 'number':
      return text({ mono: true, keyboard: 'decimal-pad' })
    default:
      return text({ mono: spec.type === 'path' })
  }
}

/** 单选的清单：可以滚，选中的反白。点一项就选上并关掉 */
function OptionPicker({
  visible,
  spec,
  value,
  onPick,
  onClose,
}: {
  visible: boolean
  spec: HcSettingSpec
  value: string
  onPick(value: string): void
  onClose(): void
}) {
  const theme = useTheme()
  const t = useT()
  const insets = useSafeAreaInsets()
  const { c } = theme
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View
        style={[
          styles.sheet,
          { backgroundColor: c.raised, borderColor: c.line3, paddingBottom: insets.bottom + 8 },
        ]}
        testID="hc:picker"
      >
        <Text style={[styles.sheetTitle, { color: c.ink2, fontFamily: theme.font.mono }]}>
          {t('hcm.pick.title', { name: t.said(spec.title) })}
          {spec.allowCustom ? `  ${t('hcm.pick.custom')}` : ''}
        </Text>
        <ScrollView>
          {spec.options.map((option) => {
            const on = option.value === value
            return (
              <Pressable
                key={option.value}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                testID={`hc:pick:${option.value}`}
                onPress={() => {
                  onClose()
                  onPick(option.value)
                }}
                style={({ pressed }) => [
                  styles.sheetRow,
                  {
                    minHeight: theme.hit,
                    borderTopColor: c.line1,
                    backgroundColor: on ? c.invBg : pressed ? c.press : 'transparent',
                  },
                ]}
              >
                <Text style={{ color: on ? c.invFg : c.ink, fontSize: 15 }}>
                  {t.said(option.title)}
                </Text>
                {option.description ? (
                  <Text style={[styles.small, { color: on ? c.invFg : c.ink3 }]}>
                    {t.said(option.description)}
                  </Text>
                ) : null}
              </Pressable>
            )
          })}
        </ScrollView>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, paddingHorizontal: 12, fontSize: 15 },
  multi: { minHeight: 96, paddingVertical: 8, textAlignVertical: 'top' },
  mono: { fontSize: 12 },
  small: { fontSize: 12, lineHeight: 17 },
  unknown: { gap: 4 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  custom: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grow: { flex: 1, minWidth: 0 },
  select: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  secret: { gap: 6 },
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
    maxHeight: '75%',
    borderTopWidth: 1,
  },
  sheetTitle: { fontSize: 12, paddingHorizontal: 16, paddingVertical: 12 },
  sheetRow: {
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
})
