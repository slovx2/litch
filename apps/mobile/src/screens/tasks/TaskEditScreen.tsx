// 新建或编辑一个定时任务：设备（新建时、不止一台能用时可换）、名字、提示词、日程（ScheduleFields，带“下一次在…”的预览）、
// 到点之后做什么（TargetFields）、建好就开始跑不跑。编辑时从开始改的那一版起改（revision），别处先改过了就换成最新的、说一声。
// 交之前先挡掉写法不对的（名字、提示词、日程、目标），设备那边还会再校验；成了就去详情页（新建）或者回去（编辑）。
import { type DeviceView, keys, type TaskView } from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useState } from 'react'
import { Keyboard, StyleSheet, Switch, Text, View } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import {
  TASK_NAME_MAX,
  TASK_PROMPT_MAX,
} from '../../../../../packages/protocol/src/device-tasks.mjs'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import { PickerSheet } from '../../detail/composer/PickerSheet'
import type { RootStackParamList } from '../../nav/routes'
import { useBusy, useChannel, useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button, Empty, Field, Row, SectionLabel } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { useNow } from '../sessions/clock'
import { previewOf } from './preview'
import { ScheduleFields } from './ScheduleFields'
import { defaultForm, formOf, type ScheduleForm } from './schedule'
import { TargetFields, type TargetForm, targetFormOf, useTargetModel } from './TargetFields'
import { todayOf } from './when'
import { phoneZone } from './zones'

type Props = NativeStackScreenProps<RootStackParamList, 'TaskEdit'>

interface Draft {
  name: string
  prompt: string
  schedule: ScheduleForm
  timezone: string
  target: TargetForm
  active: boolean
  /** 编辑：开始改的那一版 */
  revision: number | null
}

function draftOf(task: TaskView | undefined, sessionId: string | undefined, now: number): Draft {
  const zone = phoneZone()
  if (task) {
    return {
      name: task.name,
      prompt: task.prompt,
      schedule: formOf(task.schedule, todayOf(now, task.timezone)),
      timezone: task.timezone,
      target: targetFormOf(task.target),
      active: task.status !== 'paused',
      revision: task.revision,
    }
  }
  return {
    name: '',
    prompt: '',
    schedule: defaultForm(todayOf(now, zone)),
    timezone: zone,
    target: sessionId
      ? { kind: 'thread', harness: null, where: null, picks: {}, threadId: sessionId }
      : { kind: 'newThread', harness: null, where: null, picks: {}, threadId: null },
    active: true,
    revision: null,
  }
}

export function TaskEditScreen({ route, navigation }: Props) {
  const { taskId, sessionId } = route.params
  const editing = taskId !== undefined
  const [deviceId, setDeviceId] = useState(route.params.deviceId)
  const { store } = useReplica()
  const channel = useChannel()
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const now = useNow()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const available = useKey<boolean | null>(keys.tasksAvailable(deviceId))
  const latest = useKey<TaskView>(keys.task(deviceId, taskId ?? ''))
  const [draft, setDraft] = useState<Draft>(() =>
    draftOf(
      taskId ? store.get<TaskView>(keys.task(deviceId, taskId)) : undefined,
      sessionId,
      Date.now(),
    ),
  )
  const [original] = useState(() => (taskId ? (latest?.timezone ?? null) : null))
  const [picking, setPicking] = useState<string[] | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [tried, setTried] = useState(false)
  const [saving, run] = useBusy()
  const model = useTargetModel(deviceId, draft.target)
  const preview = previewOf(draft.schedule, draft.timezone, now)
  const patch = (next: Partial<Draft>) => {
    setSaid(null)
    setDraft((before) => ({ ...before, ...next }))
  }

  if (editing && !latest) {
    return (
      <Screen title={t('timed.edit')} testID="task-edit">
        <Empty title={t('timed.gone')} />
      </Screen>
    )
  }

  const nameBad =
    draft.name.trim().length === 0 || draft.name.trim().length > TASK_NAME_MAX
      ? t('timed.bad.name', { max: TASK_NAME_MAX })
      : null
  const promptBad =
    draft.prompt.trim().length === 0 || draft.prompt.length > TASK_PROMPT_MAX
      ? t('timed.bad.prompt')
      : null
  const scheduleBad =
    preview.kind === 'form'
      ? t(preview.message, preview.args ?? {})
      : preview.kind === 'invalid'
        ? preview.message
        : null
  const targetBad = model.problem ? t(model.problem) : null
  const blocked =
    available === false
      ? t('timed.device.unsupported')
      : device?.connection !== 'online'
        ? t('timed.device.offline')
        : null
  const firstProblem = blocked ?? nameBad ?? promptBad ?? scheduleBad ?? targetBad

  const save = async () => {
    Keyboard.dismiss()
    setTried(true)
    setSaid(null)
    if (firstProblem || !model.target || preview.kind === 'form' || preview.kind === 'invalid') {
      setSaid(firstProblem)
      return
    }
    const { schedule } = preview
    try {
      if (!editing) {
        const { task } = await run(
          channel.command('tasks.create', {
            deviceId,
            task: {
              name: draft.name.trim(),
              prompt: draft.prompt,
              schedule,
              timezone: draft.timezone,
              target: model.target,
              status: draft.active ? 'active' : 'paused',
            },
          }),
        )
        navigation.replace('TaskDetail', { deviceId, taskId: task.id, title: task.name })
        return
      }
      const target = model.target
      await run(
        channel.command('tasks.update', {
          deviceId,
          taskId,
          revision: draft.revision ?? 0,
          patch: {
            name: draft.name.trim(),
            prompt: draft.prompt,
            schedule,
            timezone: draft.timezone,
            ...(target.kind === 'newThread'
              ? {
                  target: {
                    cwd: target.cwd,
                    workspaceId: target.workspaceId,
                    settings: target.settings,
                  },
                }
              : {}),
          },
        }),
      )
      navigation.goBack()
    } catch (failed) {
      if ((failed as { code?: string } | null)?.code === 'conflict') {
        const fresh = store.get<TaskView>(keys.task(deviceId, taskId ?? ''))
        if (fresh) setDraft(draftOf(fresh, undefined, Date.now()))
        setSaid(t('timed.conflict'))
        return
      }
      setSaid(t('timed.failed', { reason: whyNot(failed, t) }))
    }
  }

  const pickDevice = () => {
    const ids = (store.get<string[]>(keys.devices) ?? []).filter(
      (id) => store.get<boolean | null>(keys.tasksAvailable(id)) !== false,
    )
    setPicking(ids)
  }
  const deviceName = device ? t.text(device.name) : deviceId
  return (
    <Screen
      title={t(editing ? 'timed.edit' : 'timed.new')}
      subtitle={deviceName}
      wire={device ? c.wire[device.wire] : undefined}
      testID="task-edit"
    >
      <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={24}>
        {!editing ? (
          <Row
            testID="task:device"
            title={deviceName}
            detail={t('timed.field.device')}
            onPress={pickDevice}
          />
        ) : null}
        <View style={styles.fields}>
          <Field
            label={t('timed.field.name')}
            value={draft.name}
            placeholder={t('timed.field.name.placeholder')}
            onChangeText={(name) => patch({ name })}
            maxLength={TASK_NAME_MAX}
            error={tried ? (nameBad ?? undefined) : undefined}
            testID="task:name"
          />
          <Field
            label={t('timed.field.prompt')}
            value={draft.prompt}
            placeholder={t('timed.field.prompt.placeholder')}
            onChangeText={(prompt) => patch({ prompt })}
            multiline
            autoCorrect
            error={tried ? (promptBad ?? undefined) : undefined}
            testID="task:prompt"
          />
        </View>
        <SectionLabel>{t('timed.field.schedule')}</SectionLabel>
        <ScheduleFields
          form={draft.schedule}
          onChange={(next) => patch({ schedule: { ...draft.schedule, ...next } })}
          timezone={draft.timezone}
          onTimezone={(timezone) => patch({ timezone })}
          localZone={phoneZone()}
          originalZone={original}
          preview={preview}
          now={now}
        />
        <SectionLabel>{t('timed.field.target')}</SectionLabel>
        <TargetFields
          deviceId={deviceId}
          form={draft.target}
          model={model}
          locked={editing}
          onChange={(next) => patch({ target: { ...draft.target, ...next } })}
        />
        {tried && targetBad ? (
          <Text style={[styles.note, { color: c.err }]}>{targetBad}</Text>
        ) : null}
        {!editing ? (
          <View style={styles.switchRow}>
            <Text style={[styles.switchText, { color: c.ink }]}>{t('timed.field.status')}</Text>
            <Switch
              testID="task:active"
              value={draft.active}
              onValueChange={(active) => patch({ active })}
            />
          </View>
        ) : null}
        {blocked ? <Text style={[styles.note, { color: c.err }]}>{blocked}</Text> : null}
        {said ? (
          <Text testID="task:edit:said" style={[styles.note, { color: c.err }]}>
            {said}
          </Text>
        ) : null}
        <View style={styles.save}>
          <Button
            label={t(editing ? 'timed.save' : 'timed.create')}
            testID="task:save"
            busy={saving}
            disabled={blocked !== null}
            onPress={() => void save()}
          />
        </View>
      </KeyboardAwareScrollView>
      <PickerSheet
        visible={picking !== null}
        title={t('timed.field.device')}
        value={deviceId}
        options={(picking ?? []).map((id) => {
          const each = store.get<DeviceView>(keys.device(id))
          return { id, title: each ? t.text(each.name) : id, note: each?.host ?? null }
        })}
        onPick={(id) => {
          setPicking(null)
          if (id === deviceId) return
          setDeviceId(id)
          patch({
            target: { kind: 'newThread', harness: null, where: null, picks: {}, threadId: null },
          })
        }}
        onClose={() => setPicking(null)}
        testID="task:devices"
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  fields: { gap: 14, padding: 16 },
  note: { fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingVertical: 8 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  switchText: { fontSize: 15, flex: 1 },
  save: { padding: 16, paddingBottom: 48 },
})
