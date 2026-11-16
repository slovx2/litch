import type { HarnessView } from '@litch/core'
import { useState } from 'react'
import { Text, View } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { Confirm } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'

export function RepairCodexControl({
  deviceId,
  harness,
}: {
  deviceId: string
  harness: HarnessView
}) {
  const t = useT()
  const theme = useTheme()
  const channel = useChannel()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const offered =
    harness.id === 'codex' &&
    harness.state === 'unavailable' &&
    harness.down === 'startFailed' &&
    harness.repair === 'codexControlPermissions'
  const repair = async () => {
    setAsking(false)
    setBusy(true)
    setError(null)
    try {
      const result = await channel.command('device.harness.restart', {
        deviceId,
        harness: 'codex',
        repair: 'codexControlPermissions',
      })
      if (!result.running) setError(result.text ? t.said(result.text) : t('harness.unavailable'))
    } catch (failed) {
      setError(whyNot(failed, t))
    } finally {
      setBusy(false)
    }
  }
  if (!offered && !busy && !error) return null
  return (
    <View style={{ paddingHorizontal: 16, paddingBottom: 12 }} testID="codex:repair">
      {offered || busy ? (
        <Button
          label={t(busy ? 'manage.repair.busy' : 'manage.repair')}
          disabled={busy}
          testID="codex:repair:ask"
          onPress={() => setAsking(true)}
        />
      ) : null}
      {error ? (
        <Text selectable style={{ color: theme.c.err }}>
          {t('manage.repair.failed', { reason: error })}
        </Text>
      ) : null}
      <Confirm
        visible={asking}
        title={t('manage.repair.title')}
        detail={t('manage.repair.note')}
        confirmLabel={t('manage.repair.confirm')}
        onConfirm={() => void repair()}
        onClose={() => setAsking(false)}
      />
    </View>
  )
}
