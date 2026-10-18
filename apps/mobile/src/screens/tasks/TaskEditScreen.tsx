// 新建或编辑一个定时任务：设备（新建时可换）、名字、提示词、日程（ScheduleFields，带“下一次在…”的预览）、
// 到点之后做什么（TargetFields）、建好之后先暂停不暂停。表单的样子、校验、发什么都用桌面界面那一份纯逻辑
// （packages/ui/src/tasks/form.ts：blankForm、formOf、checkForm、draftOf、patchOf），这里只管手机上怎么摆。
// 编辑时从开始改的那一版起改（revision），别处先改过了就换成最新的、说一声。成了就去详情页（新建）或者回去（编辑）。
import { type DeviceView, keys, type TaskView } from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useState } from 'react'
import { Keyboard, StyleSheet, Switch, Text, View } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import { viewerZone } from '../../../../../packages/ui/src/tasks/describe.ts'
import {
  blankForm,
  checkForm,
  draftOf,
  formOf,
  NAME_MAX,
  patchOf,
  type TaskForm,
} from '../../../../../packages/ui/src/tasks/form.ts'
import { previewOf, zoneKnown } from '../../../../../packages/ui/src/tasks/preview.ts'
import { PickerSheet } from '../../detail/composer/PickerSheet'
import type { RootStackParamList } from '../../nav/routes'
import { useBusy, useChannel, useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button, Empty, Field, Row, SectionLabel } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { useNow } from '../sessions/clock'
import { ScheduleFields } from './ScheduleFields'
import { resolvedForm, TargetFields, useTargetModel } from './TargetFields'

type Props = NativeStackScreenProps<RootStackParamList, 'TaskEdit'>

/** 新建时 harness、建在哪先空着（TargetFields 按设备算默认）；从会话里来的是“在这个会话里接着发” */
const freshForm = (deviceId: string, sessionId: string | undefined): TaskForm =>
  blankForm({ deviceId, harness: '', workspaceId: null, cwd: '', threadId: sessionId ?? null })

export function TaskEditScreen({ route, navigation }: Props) {
  const { taskId, sessionId } = route.params
  const editing = taskId !== undefined
  const [deviceId, setDeviceId] = useState(route.params.deviceId)
  const { store } = useReplica()
  const channel = useChannel()
  const t = useT()
  const { c } = useTheme()
  const now = useNow()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const available = useKey<boolean | null>(keys.tasksAvailable(deviceId))
  const latest = useKey<TaskView>(keys.task(deviceId, taskId ?? ''))
  const [start, setStart] = useState(() =>
    taskId ? store.get<TaskView>(keys.task(deviceId, taskId)) : undefined,
  )
  const [form, setForm] = useState<TaskForm>(() =>
    start ? formOf(start) : freshForm(deviceId, sessionId),
  )
  const [picking, setPicking] = useState<string[] | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [tried, setTried] = useState(false)
  const [saving, run] = useBusy()
  const model = useTargetModel(deviceId, form)
  const here = viewerZone()
  const patch = (next: Partial<TaskForm>) => {
    setSaid(null)
    setForm((before) => ({ ...before, ...next }))
  }

  if (editing && (!latest || !start)) {
    return (
      <Screen title={t('tasks.form.edit')} testID="task-edit">
        <Empty title={t('tasks.detail.gone')} />
      </Screen>
    )
  }

  const full = resolvedForm(form, model)
  const problems = checkForm(full, zoneKnown, editing)
  const preview = previewOf(full, now)
  const blocked =
    available === false
      ? t('tasks.unsupported')
      : device?.connection !== 'online'
        ? t('tasks.detail.offline')
        : form.target === 'newThread' && !model.harness
          ? t('tasks.form.noHarness')
          : null
  const shown = (key: 'name' | 'prompt') => {
    const problem = problems[key]
    return tried && problem ? t(problem) : undefined
  }
  const targetProblem = problems.cwd ?? problems.threadId

  const save = async () => {
    Keyboard.dismiss()
    setTried(true)
    setSaid(null)
    const first = Object.values(problems)[0]
    if (blocked || first) {
      setSaid(blocked ?? (first ? t(first) : null))
      return
    }
    try {
      if (!start) {
        const { task } = await run(
          channel.command('tasks.create', { deviceId, task: draftOf(full) }),
        )
        navigation.replace('TaskDetail', { deviceId, taskId: task.id, title: task.name })
        return
      }
      const changes = patchOf(start, full)
      if (changes)
        await run(
          channel.command('tasks.update', {
            deviceId,
            taskId: start.id,
            revision: start.revision,
            patch: changes,
          }),
        )
      navigation.goBack()
    } catch (failed) {
      if ((failed as { code?: string } | null)?.code === 'conflict') {
        const fresh = store.get<TaskView>(keys.task(deviceId, start?.id ?? ''))
        if (fresh) {
          setStart(fresh)
          setForm(formOf(fresh))
        }
        setSaid(t('tasks.conflict'))
        return
      }
      setSaid(t('tasks.failed', { reason: whyNot(failed, t) }))
    }
  }

  const pickDevice = () =>
    setPicking(
      (store.get<string[]>(keys.devices) ?? []).filter(
        (id) => store.get<boolean | null>(keys.tasksAvailable(id)) !== false,
      ),
    )
  const deviceName = device ? t.text(device.name) : deviceId
  return (
    <Screen
      title={t(editing ? 'tasks.form.edit' : 'tasks.form.new')}
      subtitle={deviceName}
      wire={device ? c.wire[device.wire] : undefined}
      testID="task-edit"
    >
      <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={24}>
        {!editing ? (
          <Row
            testID="task:device"
            title={deviceName}
            detail={t('tasks.form.device')}
            onPress={pickDevice}
          />
        ) : null}
        <View style={styles.fields}>
          <Field
            label={t('tasks.form.name')}
            value={form.name}
            placeholder={t('tasks.form.namePlaceholder')}
            onChangeText={(name) => patch({ name })}
            maxLength={NAME_MAX}
            error={shown('name')}
            testID="task:name"
          />
          <Field
            label={t('tasks.form.prompt')}
            value={form.prompt}
            placeholder={t('tasks.form.promptPlaceholder')}
            onChangeText={(prompt) => patch({ prompt })}
            multiline
            autoCorrect
            error={shown('prompt')}
            testID="task:prompt"
          />
        </View>
        <SectionLabel>{t('tasks.form.schedule')}</SectionLabel>
        <ScheduleFields
          form={form}
          onChange={patch}
          problems={problems}
          localZone={here}
          originalZone={start?.timezone ?? null}
          editing={editing}
          preview={preview}
          now={now}
        />
        <SectionLabel>{t('tasks.form.target')}</SectionLabel>
        <TargetFields
          deviceId={deviceId}
          form={form}
          model={model}
          locked={editing}
          problem={tried && targetProblem ? t(targetProblem) : undefined}
          onChange={patch}
        />
        {!editing ? (
          <View style={styles.switchRow}>
            <Text style={[styles.switchText, { color: c.ink }]}>{t('tasks.form.paused')}</Text>
            <Switch
              testID="task:paused"
              value={form.paused}
              onValueChange={(paused) => patch({ paused })}
            />
          </View>
        ) : null}
        {blocked ? <Text style={[styles.note, { color: c.err }]}>{blocked}</Text> : null}
        {said && said !== blocked ? (
          <Text testID="task:edit:said" style={[styles.note, { color: c.err }]}>
            {said}
          </Text>
        ) : null}
        <View style={styles.save}>
          <Button
            label={t(editing ? 'tasks.form.save' : 'tasks.form.create')}
            testID="task:save"
            busy={saving}
            disabled={blocked !== null}
            onPress={() => void save()}
          />
        </View>
      </KeyboardAwareScrollView>
      <PickerSheet
        visible={picking !== null}
        title={t('tasks.form.device')}
        value={deviceId}
        options={(picking ?? []).map((id) => {
          const each = store.get<DeviceView>(keys.device(id))
          return { id, title: each ? t.text(each.name) : id, note: each?.host ?? null }
        })}
        onPick={(id) => {
          setPicking(null)
          if (id === deviceId) return
          setDeviceId(id)
          // 换了设备：harness、项目、会话都不作数了
          patch({
            deviceId: id,
            target: 'newThread',
            harness: '',
            workspaceId: null,
            cwd: '',
            threadId: null,
            settings: { model: null, effort: null, permission: null },
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
