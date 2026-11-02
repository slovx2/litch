// 会话详情顶栏上的时钟：这个会话是哪个定时任务跑出来的（或者是哪个任务的目标会话），点了去任务详情。
// 打开任务跑出来的会话就算看过了那一次运行：核心在会话订阅上自己标（device.mts 的 openSession），这里不用管。
import { keys, type SessionTaskMark, type TaskView } from '@litch/core'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { triggerText, whenText } from '../../../../../packages/ui/src/tasks/describe.ts'
import type { RootStackParamList } from '../../nav/routes'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { useNow } from '../sessions/clock'

/**
 * 这个会话和定时任务的关系：读屏和提示用的一句话，点了去任务详情。会话详情把它画成顶栏上的一个时钟（不占高度），
 * 不是任务的会话是 null
 */
export function useSessionTask(
  deviceId: string,
  mark: SessionTaskMark | null | undefined,
): { label: string; open(): void } | null {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const task = useKey<TaskView>(keys.task(deviceId, mark?.taskId ?? ''))
  const t = useT()
  const now = useNow()
  if (!mark || !task) return null
  return {
    label:
      mark.kind === 'run'
        ? t('tasks.note.run', {
            name: task.name,
            when: whenText(mark.scheduledFor, now, t),
            trigger: triggerText(mark.trigger, t),
          })
        : t('tasks.note.target', { name: task.name }),
    open: () => navigation.navigate('TaskDetail', { deviceId, taskId: task.id, title: task.name }),
  }
}
