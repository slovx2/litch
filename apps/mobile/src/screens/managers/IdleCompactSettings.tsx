import {
  IDLE_COMPACT_MINUTES,
  IDLE_COMPACT_PERCENT,
  idleCompactInteger,
  type ManagerIdleCompactSettings,
  type ManagerView,
} from '@litch/core'
import { useState } from 'react'
import { Switch, Text, View } from 'react-native'
import { reasonOf } from '../../../../../packages/ui/src/app/errors.ts'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button, Field, Row, SectionLabel } from '../../ui/kit/controls'
import { Dialog } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'

export function IdleCompactSettings({
  manager,
  saved,
  disabled,
  onClose,
}: {
  manager: ManagerView
  saved: ManagerIdleCompactSettings
  disabled: boolean
  onClose(): void
}) {
  const t = useT()
  const channel = useChannel()
  const { c } = useTheme()
  const [enabled, setEnabled] = useState(saved.enabled)
  const [minutes, setMinutes] = useState(String(saved.idleMinutes))
  const [percent, setPercent] = useState(String(saved.contextPercent))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const idleMinutes = Number(minutes)
  const contextPercent = Number(percent)
  const minutesOk = idleCompactInteger(idleMinutes, IDLE_COMPACT_MINUTES)
  const percentOk = idleCompactInteger(contextPercent, IDLE_COMPACT_PERCENT)
  const unchanged =
    enabled === saved.enabled &&
    idleMinutes === saved.idleMinutes &&
    contextPercent === saved.contextPercent
  async function submit() {
    if (busy || disabled || unchanged || !minutesOk || !percentOk) return
    setBusy(true)
    setError('')
    try {
      await channel.command('managers.update', {
        deviceId: manager.deviceId,
        managerId: manager.id,
        patch: { idleCompact: { enabled, idleMinutes, contextPercent } },
      })
      onClose()
    } catch (cause) {
      setError(reasonOf(cause, t))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      visible
      onClose={onClose}
      footer={
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
          <Button kind="quiet" label={t('app.cancel')} onPress={onClose} />
          <Button
            label={t('manager.save')}
            busy={busy}
            testID="manager-idle-save"
            disabled={disabled || unchanged || !minutesOk || !percentOk}
            onPress={() => void submit()}
          />
        </View>
      }
    >
      <View style={{ gap: 10 }} testID="manager-idle-compact">
        <SectionLabel>{t('manager.unattended')}</SectionLabel>
        <Row
          title={t('manager.idleCompact.enabled')}
          right={
            <Switch
              value={enabled}
              onValueChange={setEnabled}
              disabled={disabled || busy}
              accessibilityLabel={t('manager.idleCompact.enabled')}
              testID="manager-idle-enabled"
            />
          }
        />
        <Text style={{ color: c.ink2 }}>{t('manager.idleCompact.hint')}</Text>
        <Field
          label={t('manager.idleCompact.minutes')}
          accessibilityLabel={t('manager.idleCompact.minutes')}
          keyboardType="number-pad"
          testID="manager-idle-minutes"
          value={minutes}
          onChangeText={setMinutes}
          editable={!disabled && !busy}
          {...(!minutesOk ? { error: t('manager.idleCompact.range', IDLE_COMPACT_MINUTES) } : {})}
        />
        <Field
          label={t('manager.idleCompact.percent')}
          accessibilityLabel={t('manager.idleCompact.percent')}
          keyboardType="number-pad"
          testID="manager-idle-percent"
          value={percent}
          onChangeText={setPercent}
          editable={!disabled && !busy}
          {...(!percentOk ? { error: t('manager.idleCompact.range', IDLE_COMPACT_PERCENT) } : {})}
        />
        {error ? (
          <Text role="alert" style={{ color: c.err }}>
            {error}
          </Text>
        ) : null}
      </View>
    </Dialog>
  )
}
