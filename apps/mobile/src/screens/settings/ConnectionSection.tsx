import { useEffect, useState } from 'react'
import { AppState, Platform, StyleSheet, Text, View } from 'react-native'
import { BACKGROUND_MINUTES, batteryState, openBatterySettings } from '../../platform/background'
import { useServices } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button, Row, SectionLabel } from '../../ui/kit/controls'
import { Sheet } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'

export function ConnectionSection() {
  const t = useT()
  const { c, font } = useTheme()
  const { prefs, setPrefs } = useServices()
  const [choosing, setChoosing] = useState(false)
  const [status, setStatus] = useState(batteryState)
  const [opened, setOpened] = useState<boolean | null>(null)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') setStatus(batteryState())
    })
    return () => subscription.remove()
  }, [])
  // 网页预览展示 Android 布局，iOS 不提供无法兑现的后台分钟数设置。
  if (Platform.OS === 'ios') return null
  const minutes = prefs.backgroundDisconnectMinutes
  const label = (value: number | null) =>
    value === null ? t('connection.never') : t('connection.minutes', { n: value })
  const note = [styles.note, { color: c.ink3, fontFamily: font.ui }]
  return (
    <View testID="settings:connection">
      <SectionLabel>{t('connection.settings')}</SectionLabel>
      <Row
        title={t('connection.timeout')}
        detail={label(minutes)}
        onPress={() => setChoosing(true)}
        testID="settings:backgroundTimeout"
      />
      <Text style={note}>
        {t(minutes === null ? 'connection.never.note' : 'connection.timeout.note')}
      </Text>
      <View style={[styles.system, { backgroundColor: c.panel, borderColor: c.line2 }]}>
        <Text style={{ color: c.ink, fontFamily: font.ui, fontSize: font.size.body }}>
          {t('connection.system')}
        </Text>
        <Text style={[styles.note, styles.inset, { color: c.ink3, fontFamily: font.ui }]}>
          {t('connection.system.note')}
        </Text>
        <Text
          testID={`settings:battery:${status}`}
          style={{
            color: status === 'restricted' ? c.wait : status === 'unknown' ? c.ink3 : c.ink2,
            fontFamily: font.ui,
            fontSize: font.size.meta,
          }}
        >
          {t(`connection.battery.${status}`)}
        </Text>
        <Text style={[styles.note, styles.inset, { color: c.ink3, fontFamily: font.ui }]}>
          {t('connection.battery.note')}
        </Text>
        <View style={{ alignSelf: 'flex-start' }}>
          <Button
            kind="plain"
            label={t('connection.open')}
            testID="settings:openBattery"
            onPress={() => setOpened(openBatterySettings())}
          />
        </View>
        {opened === false ? (
          <Text style={{ color: c.err, fontFamily: font.ui }}>{t('connection.open.failed')}</Text>
        ) : null}
        {opened !== null ? (
          <Text
            testID="settings:batteryGuide"
            style={[styles.note, styles.inset, { color: c.ink3 }]}
          >
            {t('connection.guide')}
          </Text>
        ) : null}
      </View>
      <Sheet
        visible={choosing}
        title={t('connection.timeout')}
        onClose={() => setChoosing(false)}
        actions={[...BACKGROUND_MINUTES, null].map((value) => ({
          label: label(value),
          checked: minutes === value,
          testID: `settings:backgroundTimeout:${value ?? 'never'}`,
          onPress: () => setPrefs({ backgroundDisconnectMinutes: value }),
        }))}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 16, paddingTop: 6, fontSize: 12, lineHeight: 17 },
  // 和批准钥匙那一节同样的框：说明、状态和操作放在一起，和上面的行区分开
  system: { marginTop: 12, borderTopWidth: 1, borderBottomWidth: 1, padding: 16, gap: 8 },
  inset: { paddingHorizontal: 0, paddingTop: 0 },
})
