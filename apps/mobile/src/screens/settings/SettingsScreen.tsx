// 应用设置：语言、明暗、任务卡按 harness 的开关（TaskCardsSection.tsx）、关于（版本与更新，UpdateSection.tsx）、开发者里的启动方式。都记在 prefs.json（useServices 的 prefs/setPrefs），
// 改了马上生效：语言和明暗由 App 跟着换，启动方式换了核心重新装一次。
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { RootStackParamList } from '../../nav/routes'
import type { BootMode } from '../../shell/boot'
import { type Prefs, useServices } from '../../shell/services'
import { type Key, useT } from '../../ui/i18n'
import { SectionLabel } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { CURRENT_VERSION } from '../../update/store'
import { TaskCardsSection } from './TaskCardsSection'
import { AutoUpdateSwitch, UpdateStatus } from './UpdateSection'

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>

/** 一组里挑一个：每一项一行，选中的反白 */
function Choices<V extends string>({
  name,
  value,
  options,
  onPick,
}: {
  name: string
  value: V
  options: { value: V; label: string }[]
  onPick(value: V): void
}) {
  const theme = useTheme()
  const { c } = theme
  return (
    <View accessibilityRole="radiogroup" style={[styles.group, { borderColor: c.line2 }]}>
      {options.map((option) => {
        const on = option.value === value
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            testID={`settings:${name}:${option.value}`}
            onPress={() => onPick(option.value)}
            style={({ pressed }) => [
              styles.choice,
              {
                minHeight: theme.hit,
                borderBottomColor: c.line1,
                backgroundColor: on ? c.invBg : pressed ? c.press : c.panel,
              },
            ]}
          >
            <Text
              style={[styles.mark, { color: on ? c.invFg : c.ink3, fontFamily: theme.font.mono }]}
            >
              {on ? '[x]' : '[ ]'}
            </Text>
            <Text style={[styles.choiceText, { color: on ? c.invFg : c.ink }]}>{option.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function Note({ children }: { children: ReactNode }) {
  const { c } = useTheme()
  return <Text style={[styles.note, { color: c.ink3 }]}>{children}</Text>
}

const BOOT_LABEL: Record<BootMode, Key> = {
  stored: 'sessions.settings.boot.stored',
  mock: 'sessions.settings.boot.mock',
  fixture: 'sessions.settings.boot.fixture',
}

export function SettingsScreen(_props: Props) {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const { prefs, setPrefs, booted } = useServices()
  const insets = useSafeAreaInsets()
  return (
    <Screen title={t('settings.title')} testID="settings">
      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 32 }]}>
        <SectionLabel>{t('settings.group.lang')}</SectionLabel>
        <Choices<Prefs['lang']>
          name="lang"
          value={prefs.lang}
          options={[
            { value: 'system', label: t('sessions.settings.lang.system') },
            { value: 'zh-CN', label: '中文' },
            { value: 'en', label: 'English' },
          ]}
          onPick={(lang) => setPrefs({ lang })}
        />

        <SectionLabel>{t('look.theme')}</SectionLabel>
        <Choices<Prefs['appearance']>
          name="appearance"
          value={prefs.appearance}
          options={[
            { value: 'system', label: t('theme.system') },
            { value: 'light', label: t('theme.light') },
            { value: 'dark', label: t('theme.dark') },
          ]}
          onPick={(appearance) => setPrefs({ appearance })}
        />

        <SectionLabel>{t('switches.col.taskCards')}</SectionLabel>
        <TaskCardsSection />
        <Note>
          {t('switches.note')} {t('switches.note.taskCards')}
        </Note>

        <SectionLabel>{t('settings.group.about')}</SectionLabel>
        <View style={[styles.about, { backgroundColor: c.panel, borderColor: c.line2 }]}>
          <Text style={[styles.name, { color: c.ink }]}>Litch</Text>
          <Text style={{ color: c.ink2 }}>{t('settings.about.tagline')}</Text>
          <Text testID="settings:version" style={{ color: c.ink2, fontFamily: theme.font.mono }}>
            {t('settings.about.version', { version: CURRENT_VERSION })}
          </Text>
          <UpdateStatus />
        </View>
        <AutoUpdateSwitch />

        <SectionLabel>{t('sessions.settings.dev')}</SectionLabel>
        <Text style={[styles.sub, { color: c.ink2 }]}>{t('sessions.settings.boot')}</Text>
        <Choices<BootMode>
          name="boot"
          value={prefs.boot}
          options={(['stored', 'mock', 'fixture'] as const).map((mode) => ({
            value: mode,
            label: t(BOOT_LABEL[mode]),
          }))}
          onPick={(boot) => setPrefs({ boot })}
        />
        <Note>
          {t('sessions.settings.boot.note')}{' '}
          {t('sessions.settings.mode', { mode: t(BOOT_LABEL[booted.mode]) })}
        </Note>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  body: { paddingBottom: 32 },
  group: { borderTopWidth: 1, borderBottomWidth: 1 },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  mark: { fontSize: 13 },
  choiceText: { fontSize: 15 },
  note: { paddingHorizontal: 16, paddingTop: 6, fontSize: 12, lineHeight: 17 },
  sub: { paddingHorizontal: 16, paddingBottom: 6, fontSize: 13, fontWeight: '500' },
  about: { borderTopWidth: 1, borderBottomWidth: 1, padding: 16, gap: 6 },
  name: { fontSize: 17, fontWeight: '700' },
})
