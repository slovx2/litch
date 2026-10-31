import { Text } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors'
import type { useProviderSwitch } from '../../../../../packages/ui/src/composer/useProviderSwitch'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { Dialog } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'

export function ProviderSwitchDialog({
  state,
  running,
  able,
}: {
  state: ReturnType<typeof useProviderSwitch>
  running: boolean
  able: boolean
}) {
  const t = useT()
  const { c } = useTheme()
  const busy = state.pending?.busy ?? false
  return (
    <Dialog visible onClose={state.close}>
      <Text style={{ color: c.ink, fontSize: 17, fontWeight: '600' }}>
        {t('composer.switch.title')}
      </Text>
      <Text style={{ color: c.ink2 }}>{t('composer.switch.note')}</Text>
      {busy ? (
        <Text accessibilityLiveRegion="polite" style={{ color: c.ink2 }}>
          {t('composer.switch.working')}
        </Text>
      ) : running ? (
        <Text style={{ color: c.ink2 }}>{t('composer.switch.stop')}</Text>
      ) : null}
      {!able ? <Text style={{ color: c.ink2 }}>{t('composer.switch.unavailable')}</Text> : null}
      {state.pending?.error ? (
        <Text accessibilityRole="alert" style={{ color: c.ink }}>
          {whyNot(state.pending.error, t)}
        </Text>
      ) : null}
      <Button
        label={t('composer.switch.compact')}
        busy={busy}
        disabled={running || !able}
        onPress={() => void state.confirm(true)}
      />
      <Button
        kind="plain"
        label={t('composer.switch.direct')}
        disabled={busy || running}
        onPress={() => void state.confirm(false)}
      />
      <Button kind="plain" label={t('app.cancel')} disabled={busy} onPress={state.close} />
    </Dialog>
  )
}
