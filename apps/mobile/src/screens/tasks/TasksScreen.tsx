// 定时任务的列表：按设备分组，每台设备一块（设备名带线色、这台设备的任务）；路由给了 deviceId 只列这一台。
// 一行一个任务：名字、日程的人话、下一次和最近一次的状态，右上角是没看过的几次。点进详情。
// 设备的服务不支持（deviceTasks 没列）、没连上、还没读到，各说一句。每块只订阅自己那台设备的键。
import { type DeviceView, keys, type TaskView } from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { viewerZone } from '../../../../../packages/ui/src/tasks/describe.ts'
import type { RootStackParamList } from '../../nav/routes'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Empty, Row, SectionLabel, StatusMark } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { useNow } from '../sessions/clock'
import { taskLines } from './lines'

type Props = NativeStackScreenProps<RootStackParamList, 'Tasks'>
type Navigation = Props['navigation']

function TaskRow({
  deviceId,
  taskId,
  now,
  navigation,
}: {
  deviceId: string
  taskId: string
  now: number
  navigation: Navigation
}) {
  const task = useKey<TaskView>(keys.task(deviceId, taskId))
  const t = useT()
  if (!task) return null
  const lines = taskLines(task, now, viewerZone(), t)
  return (
    <Row
      testID={`task:${taskId}`}
      title={lines.title}
      detail={lines.detail}
      meta={lines.meta}
      left={<StatusMark status={lines.mark} />}
      onPress={() => navigation.navigate('TaskDetail', { deviceId, taskId, title: task.name })}
    />
  )
}

/** 一台设备那一块。只有一台时不画设备名 */
function DeviceBlock({
  deviceId,
  titled,
  now,
  navigation,
}: {
  deviceId: string
  titled: boolean
  now: number
  navigation: Navigation
}) {
  const device = useKey<DeviceView>(keys.device(deviceId))
  const available = useKey<boolean | null>(keys.tasksAvailable(deviceId))
  const ids = useKey<string[]>(keys.taskIds(deviceId)) ?? []
  const theme = useTheme()
  const t = useT()
  if (!device) return null
  const online = device.connection === 'online'
  const note =
    available === false
      ? t('tasks.unsupported')
      : !online
        ? t(ids.length > 0 ? 'tasks.offline' : 'tasks.unknown')
        : ids.length > 0
          ? null
          : available === undefined || available === null
            ? t('tasks.loading')
            : t('tasks.empty')
  return (
    <View testID={`tasks:device:${deviceId}`}>
      {titled ? (
        <View style={styles.head}>
          <View style={[styles.wire, { backgroundColor: theme.c.wire[device.wire] }]} />
          <View style={styles.grow}>
            <SectionLabel>{t.text(device.name)}</SectionLabel>
          </View>
        </View>
      ) : null}
      {note ? (
        <Text testID={`tasks:note:${deviceId}`} style={[styles.note, { color: theme.c.ink3 }]}>
          {note}
        </Text>
      ) : null}
      {ids.map((id) => (
        <TaskRow key={id} deviceId={deviceId} taskId={id} now={now} navigation={navigation} />
      ))}
    </View>
  )
}

export function TasksScreen({ route, navigation }: Props) {
  const only = route.params?.deviceId
  const all = useKey<string[]>(keys.devices) ?? []
  const ids = only ? [only] : all
  const device = useKey<DeviceView>(keys.device(only ?? ''))
  const now = useNow()
  const t = useT()
  const { c } = useTheme()
  return (
    <Screen
      title={t('tasks.title')}
      subtitle={only && device ? t.text(device.name) : undefined}
      wire={only && device ? c.wire[device.wire] : undefined}
      actions={[
        {
          label: '＋',
          testID: 'tasks:new',
          disabled: ids.length === 0,
          onPress: () => {
            const target = only ?? ids[0]
            if (target) navigation.navigate('TaskEdit', { deviceId: target })
          },
        },
      ]}
      testID="tasks"
    >
      <ScrollView>
        {ids.length === 0 ? (
          <Empty title={t('tasks.title')} detail={t('tasks.intro')} />
        ) : (
          ids.map((id) => (
            <DeviceBlock
              key={id}
              deviceId={id}
              titled={!only && ids.length > 1}
              now={now}
              navigation={navigation}
            />
          ))
        )}
        <Text style={[styles.foot, { color: c.ink3 }]}>{t('tasks.intro')}</Text>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'stretch' },
  wire: { width: 3 },
  grow: { flex: 1 },
  note: { fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingVertical: 10 },
  foot: { fontSize: 12, lineHeight: 18, padding: 16, paddingBottom: 40 },
})
