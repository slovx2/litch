// 手机上的经理设置：空闲自动压缩。开关与名称同一行，两个短数值并排；只提交 idleCompact。
import {
  IDLE_COMPACT_MINUTES,
  IDLE_COMPACT_PERCENT,
  idleCompactSupports,
  type ManagerIdleCompactSettings,
  type ManagerView,
} from '@litch/core'
import { useState } from 'react'
import { StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { reasonOf } from '../../../../../packages/ui/src/app/errors.ts'
import {
  checkIdleCompact,
  idleCompactDraft,
} from '../../../../../packages/ui/src/manager/idle-compact-draft.ts'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
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
  const theme = useTheme()
  const { c, font } = theme
  const [draft, setDraft] = useState(() => idleCompactDraft(saved))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const check = checkIdleCompact(draft, saved)
  const locked = disabled || busy
  async function submit() {
    if (locked || !check.changed || !check.value) return
    setBusy(true)
    setError('')
    try {
      await channel.command('managers.update', {
        deviceId: manager.deviceId,
        managerId: manager.id,
        patch: { idleCompact: check.value },
      })
      onClose()
    } catch (cause) {
      setError(reasonOf(cause, t))
    } finally {
      setBusy(false)
    }
  }
  const valuesOff = locked || !draft.enabled
  const number = (
    field: 'minutes' | 'percent',
    label: string,
    unit: string,
    ok: boolean,
    range: { min: number; max: number },
  ) => (
    <View style={styles.field}>
      <Text style={[styles.label, { color: valuesOff ? c.ink3 : c.ink2 }]}>{label}</Text>
      <View style={styles.inputRow}>
        <TextInput
          accessibilityLabel={label}
          testID={`manager-idle-${field}`}
          keyboardType="number-pad"
          value={draft[field]}
          editable={!valuesOff}
          onChangeText={(value) => setDraft({ ...draft, [field]: value })}
          style={[
            styles.input,
            {
              color: valuesOff ? c.ink3 : c.ink,
              backgroundColor: valuesOff ? c.panel : c.raised,
              borderColor: ok ? c.line2 : c.err,
              borderRadius: theme.radius.m,
              minHeight: theme.hit,
              fontFamily: font.mono,
            },
          ]}
        />
        <Text style={{ color: valuesOff ? c.ink3 : c.ink2 }}>{unit}</Text>
      </View>
      {!ok ? (
        <Text style={[styles.note, { color: c.err }]}>{t('manager.idleCompact.range', range)}</Text>
      ) : null}
    </View>
  )
  return (
    <Dialog
      visible
      onClose={onClose}
      footer={
        <View style={styles.footer}>
          <Button kind="quiet" label={t('app.cancel')} onPress={onClose} />
          <Button
            label={t('manager.save')}
            busy={busy}
            testID="manager-idle-save"
            disabled={locked || !check.changed || !check.value}
            onPress={() => void submit()}
          />
        </View>
      }
    >
      <View style={styles.body} testID="manager-idle-compact">
        <Text style={{ color: c.ink, fontSize: font.size.body, fontWeight: '600' }}>
          {t('manager.idleCompact.title')}
        </Text>
        <View>
          <View style={styles.switchRow}>
            <Text style={{ flex: 1, color: c.ink, fontSize: font.size.body }}>
              {t('manager.idleCompact.enabled')}
            </Text>
            <Switch
              value={draft.enabled}
              onValueChange={(enabled) => setDraft({ ...draft, enabled })}
              disabled={locked}
              accessibilityLabel={t('manager.idleCompact.enabled')}
              testID="manager-idle-enabled"
            />
          </View>
          <Text style={[styles.note, { color: c.ink3 }]}>{t('manager.idleCompact.hint')}</Text>
          {!idleCompactSupports(manager.harness) ? (
            <Text style={[styles.note, { color: c.ink3 }]} testID="manager-idle-lines-only">
              {t('manager.idleCompact.linesOnly')}
            </Text>
          ) : null}
        </View>
        <View style={styles.values}>
          {number(
            'minutes',
            t('manager.idleCompact.minutes'),
            t('manager.idleCompact.minutesUnit'),
            check.minutesOk,
            IDLE_COMPACT_MINUTES,
          )}
          {number(
            'percent',
            t('manager.idleCompact.percent'),
            '%',
            check.percentOk,
            IDLE_COMPACT_PERCENT,
          )}
        </View>
        {error ? (
          <Text role="alert" style={{ color: c.err }}>
            {error}
          </Text>
        ) : null}
      </View>
    </Dialog>
  )
}

const styles = StyleSheet.create({
  body: { gap: 14 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  note: { fontSize: 12, lineHeight: 17 },
  values: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 20, rowGap: 10 },
  field: { gap: 6, maxWidth: 150 },
  label: { fontSize: 13, fontWeight: '500' },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { width: 72, borderWidth: 1, paddingHorizontal: 10, fontSize: 15, textAlign: 'right' },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
})
