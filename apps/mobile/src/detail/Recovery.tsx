// 执行设备观察到回合无进展时的提示（同桌面 transcript/Recovery.tsx）：样子同待答问题、子会话待处理那一族
// （等待色的边、左边一道粗线），写上最后一次进展的时刻；“中断并继续”会打断正在跑的回合，先确认一次
import { type DeviceView, keys, type TurnView } from '@litch/core'
import { useState } from 'react'
import { Alert, StyleSheet, Text, View } from 'react-native'
import { stamp } from '../../../../packages/ui/src/app/format.ts'
import { useChannel, useKey } from '../shell/services'
import { useT } from '../ui/i18n'
import { Button } from '../ui/kit/controls'
import { Confirm } from '../ui/kit/overlays'
import { useTheme } from '../ui/theme'
import { useTranscript } from './context'

export function Recovery({ turnId, recovery }: { turnId: string; recovery: TurnView['recovery'] }) {
  const { deviceId, sessionId } = useTranscript()
  const channel = useChannel()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const t = useT()
  const theme = useTheme()
  const { c, font } = theme
  const [pending, setPending] = useState(false)
  const [asking, setAsking] = useState(false)
  if (!recovery) return null
  const offline = device?.connection !== 'online'
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
        t(continueTurn ? 'turn.recovery.continue' : 'turn.recovery.wait'),
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <View
      testID="recovery"
      style={[
        styles.frame,
        { backgroundColor: c.raised, borderColor: c.wait, borderRadius: theme.radius.l },
      ]}
    >
      <Text style={{ color: c.ink2, fontSize: font.size.meta, lineHeight: 19 }}>
        {pending
          ? t('turn.recovery.pending')
          : `${t(`turn.recovery.${recovery.reason}`)} · ${t('turn.recovery.since', {
              time: stamp(recovery.lastProgressAt, Date.now(), t.lang),
            })}`}
      </Text>
      {offline ? (
        <Text style={{ color: c.ink3, fontSize: font.size.meta }}>
          {t('turn.recovery.offline')}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button
          kind="plain"
          testID="recovery-wait"
          label={t('turn.recovery.wait')}
          disabled={pending || offline}
          onPress={() => void run(false)}
        />
        <Button
          kind="danger"
          testID="recovery-continue"
          label={t('turn.recovery.continue')}
          disabled={pending || offline}
          onPress={() => setAsking(true)}
        />
      </View>
      <Confirm
        visible={asking}
        title={t('turn.recovery.confirm.title')}
        detail={t('turn.recovery.confirm.note')}
        confirmLabel={t('turn.recovery.continue')}
        danger
        onConfirm={() => {
          setAsking(false)
          void run(true)
        }}
        onClose={() => setAsking(false)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  frame: {
    marginHorizontal: 8,
    marginVertical: 6,
    padding: 12,
    gap: 10,
    borderWidth: 1,
    borderLeftWidth: 3,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
})
