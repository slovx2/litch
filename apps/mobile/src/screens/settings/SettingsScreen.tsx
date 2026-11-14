// 应用设置：外观（语言、明暗、皮肤）、任务卡按 harness 的开关（TaskCardsSection.tsx）、批准登录的钥匙指纹（ApprovalKeySection.tsx）、关于（版本与更新，UpdateSection.tsx）、开发者里的启动方式。都记在 prefs.json（useServices 的 prefs/setPrefs），
// 改了马上生效：语言和明暗由 App 跟着换，启动方式换了核心重新装一次。
// “对话”一组是回合进行中发的消息立即插进去还是排队（src/detail/composer/send-mode.ts），也记在 prefs.json。
// 几项里选一项的设置都是一行“名字　现在的值 ›”，点了出单选的选择单（Pick），和“后台断开连接”同一个样子。
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { type ReactNode, useState } from 'react'
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { SEND_MODES } from '../../../../../packages/ui/src/composer/send-mode-logic.ts'
import type { RootStackParamList } from '../../nav/routes'
import { CONTENT_FEEDBACK_EMAIL, feedbackURL, LICENSES_URL } from '../../privacy/config'
import { aiConsent } from '../../privacy/storage'
import type { BootMode } from '../../shell/boot'
import { devToolsEnabled } from '../../shell/build-mode'
import { type Prefs, useServices } from '../../shell/services'
import { type Key, useT } from '../../ui/i18n'
import { Row, SectionLabel, ValueRow } from '../../ui/kit/controls'
import { Confirm, Sheet } from '../../ui/kit/overlays'
import { Screen } from '../../ui/kit/Screen'
import { SKINS, type Skin, useTheme } from '../../ui/theme'
import { CURRENT_VERSION } from '../../update/store'
import { ApprovalKeySection } from './ApprovalKeySection'
import { ConnectionSection } from './ConnectionSection'
import { DeviceSettingsLinks } from './DeviceSettingsLinks'
import { TaskCardsSection } from './TaskCardsSection'
import { AutoUpdateSwitch, UpdateStatus } from './UpdateSection'

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>

/** 几项里选一项：一行“名字　现在的值 ›”，点了出单选的选择单（读屏角色 radio），选完收起 */
function Pick<V extends string>({
  name,
  title,
  note,
  value,
  options,
  onPick,
}: {
  name: string
  title: string
  /** 选择单标题下的说明 */
  note?: string
  value: V
  options: { value: V; label: string }[]
  onPick(value: V): void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <ValueRow
        title={title}
        value={options.find((option) => option.value === value)?.label ?? value}
        onPress={() => setOpen(true)}
        testID={`settings:${name}`}
      />
      <Sheet
        visible={open}
        title={title}
        {...(note ? { note } : {})}
        onClose={() => setOpen(false)}
        actions={options.map((option) => ({
          label: option.label,
          selected: option.value === value,
          testID: `settings:${name}:${option.value}`,
          onPress: () => onPick(option.value),
        }))}
      />
    </>
  )
}

/** 一组设置行，上下各一条线 */
function Group({ children }: { children: ReactNode }) {
  const { c } = useTheme()
  return <View style={[styles.group, { borderColor: c.line2 }]}>{children}</View>
}

function Note({ children }: { children: ReactNode }) {
  const { c } = useTheme()
  return <Text style={[styles.note, { color: c.ink3 }]}>{children}</Text>
}

const SKIN_LABEL: Record<Skin, Key> = {
  retro: 'skin.retro',
  human: 'skin.human',
  standard: 'skin.standard',
}

const BOOT_LABEL: Record<BootMode, Key> = {
  stored: 'sessions.settings.boot.stored',
  mock: 'sessions.settings.boot.mock',
  fixture: 'sessions.settings.boot.fixture',
}

export function SettingsScreen({ navigation }: Props) {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const { prefs, setPrefs, booted } = useServices()
  const insets = useSafeAreaInsets()
  const [linkError, setLinkError] = useState(false)
  const [feedback, setFeedback] = useState(false)
  const [withdrawConsent, setWithdrawConsent] = useState(false)
  const openLink = (url: string) => {
    setLinkError(false)
    void Linking.openURL(url).catch(() => setLinkError(true))
  }
  const openAbout = (page: 'privacy' | 'support') => {
    setLinkError(false)
    void Linking.openURL(`https://github.com/slovx2/litch/blob/main/docs/ios-${page}.md`).catch(
      () => setLinkError(true),
    )
  }
  return (
    <Screen
      title={t('settings.title')}
      testID="settings"
      actions={[
        {
          icon: 'plus',
          label: t('devices.add'),
          testID: 'settings:add-device',
          onPress: () => navigation.navigate('AddDevice'),
        },
      ]}
    >
      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 32 }]}>
        <DeviceSettingsLinks />
        <SectionLabel>{t('settings.general')}</SectionLabel>
        <Group>
          <Pick<Prefs['lang']>
            name="lang"
            title={t('look.lang')}
            value={prefs.lang}
            options={[
              { value: 'system', label: t('sessions.settings.lang.system') },
              { value: 'zh-CN', label: '中文' },
              { value: 'en', label: 'English' },
            ]}
            onPick={(lang) => setPrefs({ lang })}
          />
          <Pick<Prefs['appearance']>
            name="appearance"
            title={t('look.theme')}
            value={prefs.appearance}
            options={[
              { value: 'system', label: t('theme.system') },
              { value: 'light', label: t('theme.light') },
              { value: 'dark', label: t('theme.dark') },
            ]}
            onPick={(appearance) => setPrefs({ appearance })}
          />
          <Pick<Skin>
            name="skin"
            title={t('look.skin')}
            value={prefs.skin}
            options={SKINS.map((skin) => ({ value: skin, label: t(SKIN_LABEL[skin]) }))}
            onPick={(skin) => setPrefs({ skin })}
          />
        </Group>

        <SectionLabel>{t('settings.group.chat')}</SectionLabel>
        <Group>
          <Pick<Prefs['sendMode']>
            name="sendMode"
            title={t('settings.chat.sendMode')}
            note={t('settings.chat.sendMode.note')}
            value={prefs.sendMode}
            options={SEND_MODES.map((mode) => ({
              value: mode,
              label: t(`settings.chat.mode.${mode}`),
            }))}
            onPick={(sendMode) => setPrefs({ sendMode })}
          />
        </Group>

        <ConnectionSection />
        <Row
          title={t('tailscale.title')}
          onPress={() => navigation.navigate('Tailscale')}
          testID="settings:tailscale"
        />

        <SectionLabel>{t('switches.col.taskCards')}</SectionLabel>
        <TaskCardsSection />
        {/* 统一设置整台设备的说明在每台设备的选择单里 */}
        <Note>{t('switches.note.taskCards')}</Note>

        <SectionLabel>{t('approval.settings')}</SectionLabel>
        <ApprovalKeySection />
        <Note>{t('approval.settings.note')}</Note>

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
        {Platform.OS === 'android' ? (
          <Row
            title={t('app.privacy')}
            onPress={() => openAbout('privacy')}
            testID="settings:privacy"
          />
        ) : null}
        {Platform.OS === 'ios' ? (
          <>
            <Row
              title={t('app.privacy')}
              trail="external"
              onPress={() => openAbout('privacy')}
              testID="settings:privacy"
            />
            <Row
              title={t('app.support')}
              trail="external"
              onPress={() => openAbout('support')}
              testID="settings:support"
            />
          </>
        ) : null}

        <Row
          title={t('privacy.feedback')}
          trail={CONTENT_FEEDBACK_EMAIL ? 'external' : 'forward'}
          testID="settings:feedback"
          onPress={() =>
            CONTENT_FEEDBACK_EMAIL
              ? openLink(feedbackURL(t('privacy.feedback')))
              : setFeedback(true)
          }
        />
        <Row
          title={t('privacy.licenses')}
          trail="external"
          testID="settings:licenses"
          onPress={() => openLink(LICENSES_URL)}
        />
        {linkError ? <Note>{t('app.openLinkFailed')}</Note> : null}
        {Platform.OS === 'ios' ? (
          <>
            <Row
              title={t('privacy.ai.settings')}
              testID="settings:ai-consent"
              onPress={() => aiConsent.open()}
            />
            <Row
              title={t('privacy.ai.reset')}
              trail="none"
              testID="settings:withdraw-consent"
              onPress={() => setWithdrawConsent(true)}
            />
            <Confirm
              visible={withdrawConsent}
              title={t('privacy.ai.reset')}
              detail={t('privacy.ai.resetDetail')}
              confirmLabel={t('privacy.continue')}
              onClose={() => setWithdrawConsent(false)}
              onConfirm={() => aiConsent.withdraw()}
            />
          </>
        ) : null}
        {devToolsEnabled() ? (
          <>
            <SectionLabel>{t('sessions.settings.dev')}</SectionLabel>
            <Group>
              <Pick<BootMode>
                name="boot"
                title={t('sessions.settings.boot')}
                value={prefs.boot}
                options={(['stored', 'mock', 'fixture'] as const).map((mode) => ({
                  value: mode,
                  label: t(BOOT_LABEL[mode]),
                }))}
                onPick={(boot) => setPrefs({ boot })}
              />
            </Group>
            <Note>
              {t('sessions.settings.boot.note')}{' '}
              {t('sessions.settings.mode', { mode: t(BOOT_LABEL[booted.mode]) })}
            </Note>
          </>
        ) : null}
        <Confirm
          visible={feedback}
          title={t('privacy.feedback')}
          detail={t('privacy.publicFeedback')}
          confirmLabel={t('privacy.continue')}
          onClose={() => setFeedback(false)}
          onConfirm={() => openLink(feedbackURL(t('privacy.feedback')))}
        />
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  body: { paddingBottom: 32 },
  group: { borderTopWidth: 1, borderBottomWidth: 1 },
  note: { paddingHorizontal: 16, paddingTop: 6, fontSize: 12, lineHeight: 17 },
  about: { borderTopWidth: 1, borderBottomWidth: 1, padding: 16, gap: 6 },
  name: { fontSize: 17, fontWeight: '700' },
})
