import { useState } from 'react'
import { View } from 'react-native'
import { tailscaleAvailable } from '../../platform/tailscale'
import { useT } from '../../ui/i18n'
import { Row, ValueRow } from '../../ui/kit/controls'
import { Icon } from '../../ui/kit/Icon'
import { Sheet } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'

export type TailscaleMode = 'auto' | 'always' | 'never'

export function TailscaleChoice({
  value,
  onChange,
  configure,
  disabled = false,
}: {
  value: TailscaleMode
  onChange(value: TailscaleMode): void
  configure(): void
  disabled?: boolean
}) {
  const t = useT()
  const { c } = useTheme()
  const [open, setOpen] = useState(false)
  const available = tailscaleAvailable()
  return (
    <View>
      <ValueRow
        title={t('tailscale.switch')}
        value={t(`tailscale.mode.${value}`)}
        onPress={() => {
          if (!disabled) setOpen(true)
        }}
        testID="tailscale:mode"
      />
      <Row
        title={t('tailscale.guide')}
        right={<Icon name="forward" size={16} color={c.ink3} />}
        onPress={configure}
        testID="tailscale:guide"
      />
      <Sheet
        visible={open}
        title={t('tailscale.switch')}
        note={t('tailscale.mode.hint')}
        onClose={() => setOpen(false)}
        actions={(['auto', 'always', 'never'] as const).map((mode) => ({
          label: t(`tailscale.mode.${mode}`),
          selected: mode === value,
          disabled: mode === 'always' && !available ? t('tailscale.unavailable') : undefined,
          testID: `tailscale:mode:${mode}`,
          onPress: () => onChange(mode),
        }))}
      />
    </View>
  )
}
