// 会话详情顶上的一条：这个会话里有几个建议任务等着开始，点了去建议任务列表。没有等着的就不显示
// （列表本身从右上角菜单里的“建议任务”也能进）。
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { Pressable, StyleSheet, Text } from 'react-native'
import { useProposalClock, useProposalList } from '../../detail/proposals/hooks'
import { pendingCount } from '../../detail/proposals/logic'
import type { RootStackParamList } from '../../nav/routes'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'

export function ProposalsStrip({
  deviceId,
  sessionId,
  title,
}: {
  deviceId: string
  sessionId: string
  title: string
}) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const theme = useTheme()
  const t = useT()
  const list = useProposalList(deviceId, sessionId)
  const now = useProposalClock(list)
  const n = pendingCount(list ?? [], now)
  if (n === 0) return null
  return (
    <Pressable
      accessibilityRole="button"
      testID="detail:proposals"
      onPress={() => navigation.navigate('Proposals', { deviceId, sessionId, title })}
      style={({ pressed }) => [
        styles.strip,
        {
          backgroundColor: pressed ? theme.c.press : theme.c.raised,
          borderBottomColor: theme.c.line1,
        },
      ]}
    >
      <Text
        numberOfLines={1}
        style={[styles.text, { color: theme.c.wait, fontFamily: theme.font.mono }]}
      >
        ◇ {t('proposals.strip', { n })} ›
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  strip: { paddingHorizontal: 16, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  text: { fontSize: 12 },
})
