// 一个定时任务的详情：日程、状态、目标、提示词；立即运行、暂停继续、编辑、删除（要确认）；运行记录（新的在前，
// 往下翻页）。点一条运行记录进它跑在的会话（核心打开会话时把里面跑完的运行标成看过）。运行记录开着这一页才订阅（replica.openTaskRuns）。
import {
  type DeviceView,
  keys,
  type TaskRunsPage,
  type TaskRunView,
  type TaskView,
} from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useEffect, useState } from 'react'
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import {
  errorText,
  scheduleLine,
  viewerZone,
  whenText,
} from '../../../../../packages/ui/src/tasks/describe.ts'
import type { RootStackParamList } from '../../nav/routes'
import { useBusy, useChannel, useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button, Empty, Row, SectionLabel, StatusMark } from '../../ui/kit/controls'
import { Confirm } from '../../ui/kit/overlays'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { InfoLine } from '../devices/parts'
import { useNow } from '../sessions/clock'
import { runLines } from './lines'
import { useOriginLine, useTargetLine } from './target'

type Props = NativeStackScreenProps<RootStackParamList, 'TaskDetail'>

export function TaskDetailScreen({ route, navigation }: Props) {
  const { deviceId, taskId } = route.params
  const task = useKey<TaskView>(keys.task(deviceId, taskId))
  const device = useKey<DeviceView>(keys.device(deviceId))
  const replica = useReplica()
  const channel = useChannel()
  const theme = useTheme()
  const { c } = theme
  const t = useT()
  const now = useNow()
  const target = useTargetLine(deviceId, task?.target)
  const origin = useOriginLine(deviceId, task?.origin)
  const [running, runNow] = useBusy()
  const [toggling, toggle] = useBusy()
  const [deleting, setDeleting] = useState(false)
  const [said, setSaid] = useState<{ text: string; bad: boolean } | null>(null)
  useEffect(() => replica.openTaskRuns(deviceId, taskId), [replica, deviceId, taskId])
  const page = useKey<TaskRunsPage>(keys.taskRuns(deviceId, taskId))
  const title = task?.name ?? route.params.title ?? t('tasks.title')
  const online = device?.connection === 'online'

  const fail = (failed: unknown) =>
    setSaid({ text: t('tasks.failed', { reason: whyNot(failed, t) }), bad: true })
  const doRunNow = () => {
    setSaid(null)
    runNow(channel.command('tasks.runNow', { deviceId, taskId })).then(
      (result) =>
        setSaid({
          text: t(result.deduplicated ? 'tasks.detail.already' : 'tasks.detail.started'),
          bad: false,
        }),
      fail,
    )
  }
  const doToggle = () => {
    if (!task) return
    setSaid(null)
    toggle(
      channel.command('tasks.pause', { deviceId, taskId, paused: task.status !== 'paused' }),
    ).catch(fail)
  }
  const openRun = (run: TaskRunView) => {
    if (!run.threadId) return
    navigation.navigate('Detail', { deviceId, sessionId: run.threadId })
  }
  const markAll = () => void channel.command('tasks.markRead', { deviceId, taskId }).catch(fail)

  if (!task) {
    return (
      <Screen title={title} testID="task-detail">
        <Empty title={t('tasks.detail.gone')} />
      </Screen>
    )
  }
  const statusLine =
    task.status === 'active' && task.nextRunAt !== null
      ? whenText(task.nextRunAt, now, t)
      : t(`tasks.status.${task.status}`)
  return (
    <Screen
      title={title}
      subtitle={device ? t.text(device.name) : undefined}
      wire={device ? c.wire[device.wire] : undefined}
      actions={[
        {
          label: t('tasks.detail.edit'),
          testID: 'task:edit',
          disabled: !online,
          onPress: () => navigation.navigate('TaskEdit', { deviceId, taskId }),
        },
      ]}
      testID="task-detail"
    >
      <ScrollView>
        <InfoLine
          label={t('tasks.detail.schedule')}
          value={scheduleLine(task, t, viewerZone(), now)}
          testID="task:detail:schedule"
        />
        <InfoLine label={t('tasks.detail.next')} value={statusLine} testID="task:detail:status" />
        <InfoLine label={t('tasks.detail.target')} value={target} testID="task:detail:target" />
        <InfoLine label={t('tasks.detail.origin')} value={origin} />
        {task.lastError ? (
          <Text testID="task:detail:error" style={[styles.note, { color: c.err }]}>
            {t('tasks.error.line', {
              reason: t('tasks.detail.lastError'),
              message: errorText(task.lastError, t),
            })}
          </Text>
        ) : null}
        <Text
          selectable
          style={[
            styles.prompt,
            {
              color: c.ink,
              backgroundColor: c.sunken,
              borderColor: c.line1,
              borderRadius: theme.radius.l,
              overflow: 'hidden',
            },
          ]}
        >
          {task.prompt}
        </Text>
        <View style={styles.buttons}>
          <Button
            label={t('tasks.detail.runNow')}
            testID="task:runNow"
            busy={running}
            disabled={!online}
            onPress={doRunNow}
          />
          <Button
            kind="plain"
            label={t(task.status === 'paused' ? 'tasks.detail.resume' : 'tasks.detail.pause')}
            testID="task:toggle"
            busy={toggling}
            disabled={!online || task.status === 'completed'}
            onPress={doToggle}
          />
          <Button
            kind="danger"
            label={t('tasks.detail.delete')}
            testID="task:delete"
            disabled={!online}
            onPress={() => setDeleting(true)}
          />
        </View>
        {said ? (
          <Text testID="task:said" style={[styles.note, { color: said.bad ? c.err : c.ink2 }]}>
            {said.text}
          </Text>
        ) : null}
        {!online ? (
          <Text style={[styles.note, { color: c.ink3 }]}>{t('tasks.detail.offline')}</Text>
        ) : null}

        <SectionLabel
          right={
            task.unreadRuns > 0 ? (
              <Text
                accessibilityRole="button"
                testID="task:markAll"
                onPress={markAll}
                style={[styles.link, { color: c.accent }]}
              >
                {t('timed.runs.markRead')}
              </Text>
            ) : undefined
          }
        >
          {t('tasks.detail.runs')}
        </SectionLabel>
        {(page?.runs ?? []).map((run) => {
          const lines = runLines(run, now, t)
          return (
            <Row
              key={run.id}
              testID={`run:${run.id}`}
              title={lines.title}
              detail={lines.detail || (run.threadId ? undefined : t('tasks.run.pending'))}
              left={<StatusMark status={lines.mark} />}
              onPress={run.threadId ? () => openRun(run) : undefined}
            />
          )
        })}
        {page && !page.loading && page.runs.length === 0 && !page.error ? (
          <Text style={[styles.note, { color: c.ink3 }]}>{t('tasks.detail.noRuns')}</Text>
        ) : null}
        {page?.error ? (
          <Text style={[styles.note, { color: c.err }]}>
            {t('tasks.failed', { reason: whyNot(page.error, t) })}
          </Text>
        ) : null}
        {!page || page.loading ? (
          <ActivityIndicator style={styles.spin} color={c.ink2} />
        ) : page.nextCursor ? (
          <View style={styles.more}>
            <Button
              kind="plain"
              label={t('tasks.detail.more')}
              testID="task:runs:more"
              onPress={() => replica.moreTaskRuns(deviceId, taskId)}
            />
          </View>
        ) : null}
        <View style={styles.end} />
      </ScrollView>
      <Confirm
        visible={deleting}
        danger
        title={t('tasks.detail.deleteAsk')}
        detail={t('tasks.detail.deleteNote')}
        confirmLabel={t('tasks.detail.delete')}
        onConfirm={() => {
          channel
            .command('tasks.delete', { deviceId, taskId })
            .then(() => navigation.goBack(), fail)
        }}
        onClose={() => setDeleting(false)}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  note: { fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingVertical: 8 },
  prompt: {
    fontSize: 14,
    lineHeight: 20,
    marginHorizontal: 16,
    marginVertical: 8,
    padding: 12,
    borderWidth: 1,
  },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, padding: 16, paddingBottom: 8 },
  link: { fontSize: 13 },
  spin: { padding: 16 },
  more: { padding: 16 },
  end: { height: 40 },
})
