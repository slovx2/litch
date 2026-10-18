// 会话详情顶上的一条：这个会话是哪个定时任务跑出来的（或者是哪个任务的目标会话），点了去任务详情。
// 打开任务跑出来的会话就算看过了那一次运行：核心在会话订阅上自己标（device.mts 的 openSession），这里不用管。
import { keys, type SessionTaskMark, type TaskView } from '@litch/core'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { Pressable, StyleSheet, Text } from 'react-native'
import type { RootStackParamList } from '../../nav/routes'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { useNow } from '../sessions/clock'
import { whenText } from './when'

export function SessionTaskStrip({
  deviceId,
  mark,
}: {
  deviceId: string
  mark: SessionTaskMark | null | undefined
}) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const task = useKey<TaskView>(keys.task(deviceId, mark?.taskId ?? ''))
  const theme = useTheme()
  const t = useT()
  const now = useNow()
  if (!mark || !task) return null
  const text =
    mark.kind === 'run'
      ? `${t('timed.mark')} · ${task.name} · ${t('timed.run.for', { when: whenText(mark.scheduledFor, now, t) })}`
      : `${t('timed.mark')} · ${task.name}`
  return (
    <Pressable
      accessibilityRole="button"
      testID="detail:task"
      onPress={() =>
        navigation.navigate('TaskDetail', { deviceId, taskId: task.id, title: task.name })
      }
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
        style={[styles.text, { color: theme.c.ink2, fontFamily: theme.font.mono }]}
      >
        ⏱ {text}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  strip: { paddingHorizontal: 16, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  text: { fontSize: 12 },
})
