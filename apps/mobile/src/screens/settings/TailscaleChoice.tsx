import { StyleSheet, Switch, Text, View } from 'react-native'
import { tailscaleAvailable } from '../../platform/tailscale'
import { useT } from '../../ui/i18n'
import { Row } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'

export function TailscaleChoice({
  value,
  onChange,
  configure,
  disabled = false,
}: {
  value: boolean
  onChange(value: boolean): void
  configure(): void
  disabled?: boolean
}) {
  const t = useT()
  const { c, font } = useTheme()
  const available = tailscaleAvailable()
  return (
    <View>
      <Row
        title={t('tailscale.switch')}
        right={
          <Switch
            value={value}
            testID="tailscale:switch"
            accessibilityLabel={t('tailscale.switch')}
            disabled={disabled || (!available && !value)}
            onValueChange={onChange}
            trackColor={{ false: c.line3, true: c.accentSolid }}
            thumbColor={c.raised}
          />
        }
      />
      {!available ? (
        <Text style={[styles.note, { color: c.ink3, fontFamily: font.ui }]}>
          {t('tailscale.unavailable')}
        </Text>
      ) : null}
      <Row
        title={t('tailscale.guide')}
        left={<Text style={{ color: c.ink2 }}>↗</Text>}
        onPress={configure}
        testID="tailscale:guide"
      />
    </View>
  )
}
const styles = StyleSheet.create({ note: { paddingHorizontal: 16, fontSize: 12, lineHeight: 17 } })
