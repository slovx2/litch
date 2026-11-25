import { useEffect, useState } from 'react'
import { ScrollView, Text, View } from 'react-native'
import type { MachineApprovalCard } from '../../../../../packages/protocol/src/machine-approvals.mts'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'

export function DeferredMachineCards({
  deviceId,
  sessionId,
}: {
  deviceId: string
  sessionId: string
}) {
  const channel = useChannel()
  const theme = useTheme()
  const t = useT()
  const [cards, setCards] = useState<MachineApprovalCard[]>([])
  useEffect(
    () =>
      channel.subscribe(
        { kind: 'machineApprovals', deviceId },
        { snapshot: setCards, delta: () => {}, error: () => setCards([]) },
      ),
    [channel, deviceId],
  )
  const mine = cards.filter((card) => card.threadId === sessionId)
  if (!mine.length) return null
  return (
    <ScrollView style={{ maxHeight: 150 }} keyboardShouldPersistTaps="handled">
      {mine.map((card) => (
        <View
          key={card.id}
          testID={`machine-deferred:${card.id}`}
          style={{
            gap: 4,
            paddingHorizontal: 12,
            paddingVertical: 8,
            backgroundColor: theme.c.panel,
            borderTopColor: theme.c.line2,
            borderTopWidth: 1,
          }}
        >
          <Text style={{ color: theme.c.ink }}>{t(`machine.ask.${card.action}`)}</Text>
          <Text style={{ color: theme.c.ink3 }}>{t('machine.deferred.waiting')}</Text>
          <Text numberOfLines={3} style={{ color: theme.c.ink, fontFamily: theme.font.mono }}>
            {card.target}
          </Text>
          <Text style={{ color: theme.c.ink3 }}>
            {t('machine.deferred.onMac', { name: card.desktop })}
          </Text>
        </View>
      ))}
    </ScrollView>
  )
}
