// 一项设置的控件：按设备服务声明的类型画（packages/core/src/model-manage.mts 的 SettingSpecView），哪一项都不认识。
// 改的值先记成草稿（draft），由外面一起保存。密钥只写不读：显示“已设置/未设置”，填了新的才算改。
// 环境变量表手机上只看个数，改在电脑上的 Litch 里做；不认识的类型只能看。
import type { SettingEditView, SettingSpecView, SettingValueView } from '@litch/core'
import type { ComponentProps, ReactNode } from 'react'
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'

export type Draft = SettingEditView['value'] | undefined

/** 填的值对不对。对的是 null */
export function problemOf(
  spec: SettingSpecView,
  draft: Draft,
  t: ReturnType<typeof useT>,
): string | null {
  if (spec.type !== 'integer' || typeof draft !== 'string') return null
  if (!/^-?\d+$/.test(draft.trim())) return t('manage.problem.integer')
  const value = Number(draft)
  if (spec.minimum !== null && value < spec.minimum) {
    return t('manage.problem.min', { minimum: spec.minimum })
  }
  if (spec.maximum !== null && value > spec.maximum) {
    return t('manage.problem.max', { maximum: spec.maximum })
  }
  return null
}

/** 草稿变成要写入的值：整数从字换成数，密钥留空就是不改 */
export function editOf(spec: SettingSpecView, draft: Draft): SettingEditView | null {
  if (draft === undefined) return null
  if (spec.type === 'integer' && typeof draft === 'string') {
    return { key: spec.key, value: Number(draft.trim()) }
  }
  if (spec.type === 'secret' && draft === '') return null
  return { key: spec.key, value: draft }
}

export function SettingControl({
  spec,
  value,
  draft,
  onDraft,
}: {
  spec: SettingSpecView
  value: SettingValueView
  draft: Draft
  onDraft(next: Draft): void
}) {
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  const problem = problemOf(spec, draft, t)
  const input = (props: Partial<ComponentProps<typeof TextInput>>) => (
    <TextInput
      autoCapitalize="none"
      autoCorrect={false}
      placeholderTextColor={c.ink3}
      testID={`setting:${spec.key}`}
      {...props}
      style={[
        styles.input,
        {
          color: c.ink,
          backgroundColor: c.raised,
          borderColor: problem ? c.err : c.line2,
          borderRadius: theme.radius.m,
          minHeight: theme.hit,
          fontFamily: theme.font.mono,
        },
      ]}
    />
  )
  let control: ReactNode
  switch (spec.type) {
    case 'boolean':
      control = (
        <Switch
          testID={`setting:${spec.key}`}
          value={(draft ?? value) === true}
          onValueChange={(next) => onDraft(next === value ? undefined : next)}
          trackColor={{ true: c.accent, false: c.line2 }}
        />
      )
      break
    case 'integer':
      control = input({
        keyboardType: 'number-pad',
        value: typeof draft === 'string' ? draft : value === null ? '' : String(value),
        onChangeText: (text) => onDraft(text === String(value ?? '') ? undefined : text),
      })
      break
    case 'string':
    case 'path':
      control = input({
        value: typeof draft === 'string' ? draft : typeof value === 'string' ? value : '',
        placeholder: t('manage.text.empty'),
        onChangeText: (text) => onDraft(text === value ? undefined : text),
      })
      break
    case 'secret': {
      const set = typeof value === 'object' && value !== null && 'set' in value && value.set
      control = input({
        secureTextEntry: true,
        value: typeof draft === 'string' ? draft : '',
        placeholder: t(set ? 'manage.secret.replace' : 'manage.secret.enter'),
        onChangeText: (text) => onDraft(text || undefined),
      })
      break
    }
    case 'enum':
      control = (
        <View style={styles.options}>
          {spec.options.map((option) => {
            const picked = (draft ?? value) === option.value
            return (
              <Pressable
                key={option.value}
                accessibilityRole="button"
                accessibilityState={{ selected: picked }}
                testID={`setting:${spec.key}:${option.value}`}
                onPress={() => onDraft(option.value === value ? undefined : option.value)}
                style={[
                  styles.option,
                  {
                    borderColor: c.line2,
                    backgroundColor: picked ? c.selBg : c.raised,
                    borderRadius: theme.radius.m,
                  },
                ]}
              >
                <Text style={{ color: picked ? c.selFg : c.ink }}>{t.said(option.title)}</Text>
              </Pressable>
            )
          })}
        </View>
      )
      break
    case 'env':
      control = (
        <Text style={[styles.small, { color: c.ink2 }]}>
          {t('manage.value.env', { count: Array.isArray(value) ? value.length : 0 })} ·{' '}
          {t('devices.manage.env')}
        </Text>
      )
      break
    default:
      control = (
        <Text style={[styles.small, { color: c.ink3 }]}>
          {t('manage.unknown.note', { type: spec.type })}
        </Text>
      )
  }
  const inline = spec.type === 'boolean'
  return (
    <View style={styles.setting}>
      <View style={inline ? styles.inline : null}>
        <View style={inline ? styles.grow : null}>
          <Text style={[styles.title, { color: c.ink }]}>
            {t.said(spec.title)}
            {spec.restart === 'harness' ? (
              <Text style={{ color: c.wait }}> · {t('manage.restartTag')}</Text>
            ) : null}
          </Text>
          <Text style={[styles.small, { color: c.ink3 }]}>{t.said(spec.description)}</Text>
        </View>
        {inline ? control : null}
      </View>
      {inline ? null : control}
      {problem ? <Text style={[styles.small, { color: c.err }]}>{problem}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  setting: { paddingHorizontal: 16, paddingVertical: 10, gap: 6 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1 },
  title: { fontSize: 15, fontWeight: '500' },
  small: { fontSize: 12, lineHeight: 17 },
  input: { borderWidth: 1, paddingHorizontal: 12, fontSize: 14 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  option: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
})
