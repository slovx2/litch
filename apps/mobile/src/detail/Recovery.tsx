import { type DeviceView, keys, type TurnView } from '@litch/core'
import { useState } from 'react'
import { Alert, Text, View } from 'react-native'
import { useChannel, useKey } from '../shell/services'
import { useT } from '../ui/i18n'
import { Button } from '../ui/kit/controls'
import { useTheme } from '../ui/theme'
import { useTranscript } from './context'

export function Recovery({ turnId, recovery }: { turnId: string; recovery: TurnView['recovery'] }) {
  const { deviceId, sessionId } = useTranscript()
  const channel = useChannel()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const t = useT(),
    { c, font } = useTheme()
  const [pending, setPending] = useState(false)
  if (!recovery) return null
  const run = async (continueTurn: boolean) => {
    if (pending) return
    setPending(true)
    try {
      const ref = { deviceId, sessionId, turnId }
      if (continueTurn)
        await channel.command('session.recover', { ...ref, text: t('turn.recovery.prompt') })
      else await channel.command('session.dismissRecovery', ref)
    } catch (error) {
      Alert.alert(
        t('turn.recovery.continue'),
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <View style={{ padding: 12, gap: 10, borderWidth: 1, borderColor: c.wait }}>
      <Text style={{ color: c.ink, fontSize: font.size.small + 1 }}>
        {t(pending ? 'turn.recovery.pending' : `turn.recovery.${recovery.reason}`)}
      </Text>
      {device?.connection !== 'online' ? (
        <Text style={{ color: c.ink2 }}>{t('turn.recovery.offline')}</Text>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {[false, true].map((continueTurn) => (
          <Button
            key={String(continueTurn)}
            kind="plain"
            testID={continueTurn ? 'recovery-continue' : 'recovery-wait'}
            label={t(continueTurn ? 'turn.recovery.continue' : 'turn.recovery.wait')}
            disabled={pending || device?.connection !== 'online'}
            onPress={() => void run(continueTurn)}
          />
        ))}
      </View>
    </View>
  )
}
