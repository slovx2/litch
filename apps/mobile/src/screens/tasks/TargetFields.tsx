// 表单里“到点之后”一块：每次新建会话（harness、项目或目录、模型强度权限，选择器和新建会话页的是同一套），
// 或者在一个已有会话里接着发（挑会话）。编辑时种类、harness、会话改不了（协议的规矩），只写出来。
// 表单的样子是桌面界面的 TaskForm（packages/ui/src/tasks/form.ts）；harness 空着是“可用的第一个”，
// 项目和目录都空着是“第一个项目”：useTargetModel 把这些默认算出来，resolvedForm 填回表单再去校验、发出去。
import {
  type DeviceView,
  keys,
  newSessionSettings,
  type SessionGroups,
  type SessionSettings,
  type SessionSummary,
  type WorkspaceView,
} from '@litch/core'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { TaskForm } from '../../../../../packages/ui/src/tasks/form.ts'
import { useComposeOptions, useNewSessionDefaults } from '../../detail/composer/options'
import { PickerSheet } from '../../detail/composer/PickerSheet'
import { SettingsBar } from '../../detail/composer/SettingsBar'
import { useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Chip, Row } from '../../ui/kit/controls'
import { Prompt } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'

export interface TargetModel {
  /** 实际用的 harness；一个可用的都没有是 null */
  harness: string | null
  /** 实际建在哪：项目（workspaceId 和它的根）或者自己填的目录（workspaceId 是 null） */
  workspaceId: string | null
  cwd: string
  /** 设置条上显示的（没选的显示对面的默认） */
  shown: SessionSettings
  options: ReturnType<typeof useComposeOptions>
}

export function useTargetModel(deviceId: string, form: TaskForm): TargetModel {
  const device = useKey<DeviceView>(keys.device(deviceId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId))
  const summary = useKey<SessionSummary>(keys.summary(deviceId, form.threadId ?? ''))
  const ready = device?.harnesses.filter((entry) => entry.state === 'ready') ?? []
  const harness =
    form.target === 'thread'
      ? (summary?.harness ?? (form.harness || null))
      : form.harness || ready[0]?.id || null
  const first = workspaces?.find((entry) => entry.roots[0])
  const chosen = form.workspaceId
    ? workspaces?.find((entry) => entry.id === form.workspaceId)
    : undefined
  const place =
    form.workspaceId || form.cwd
      ? { workspaceId: form.workspaceId, cwd: chosen?.roots[0] ?? form.cwd }
      : { workspaceId: first?.id ?? null, cwd: first?.roots[0] ?? '' }
  const live = form.target === 'newThread' ? (harness ?? undefined) : undefined
  const options = useComposeOptions(deviceId, live)
  const defaults = useNewSessionDefaults(deviceId, live, place.cwd || null)
  const picks = Object.fromEntries(
    Object.entries(form.settings).filter(([, value]) => value !== null),
  ) as Partial<SessionSettings>
  const settled = options ? newSessionSettings(picks, defaults, options) : null
  return {
    harness,
    ...place,
    shown: {
      model: settled?.model ?? form.settings.model,
      effort: settled?.effort ?? form.settings.effort,
      permission: settled?.permission ?? form.settings.permission,
      mode: null,
    },
    options,
  }
}

/** 把默认算出来的 harness 和建在哪填回表单。设置照用户选了的发（没选的是 null：用 harness 的默认），和桌面端一样 */
export function resolvedForm(form: TaskForm, model: TargetModel): TaskForm {
  return { ...form, harness: model.harness ?? '', workspaceId: model.workspaceId, cwd: model.cwd }
}

/** 设备上能接着发的会话（没归档的），最近动过的在前 */
function threadsOf(deviceId: string, store: ReturnType<typeof useReplica>['store']) {
  const groups = store.get<SessionGroups>(keys.groups(deviceId)) ?? {}
  const seen = new Set<string>()
  const list: SessionSummary[] = []
  for (const ids of Object.values(groups)) {
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      const summary = store.get<SessionSummary>(keys.summary(deviceId, id))
      if (summary) list.push(summary)
    }
  }
  return list.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function TargetFields({
  deviceId,
  form,
  model,
  locked,
  problem,
  onChange,
}: {
  deviceId: string
  form: TaskForm
  model: TargetModel
  /** 编辑：种类、harness、会话改不了 */
  locked: boolean
  /** 这一块没填对的地方（目录、会话） */
  problem: string | undefined
  onChange(patch: Partial<TaskForm>): void
}) {
  const t = useT()
  const { c } = useTheme()
  const { store } = useReplica()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId)) ?? []
  const summary = useKey<SessionSummary>(keys.summary(deviceId, form.threadId ?? ''))
  const [asking, setAsking] = useState(false)
  const [picking, setPicking] = useState<SessionSummary[] | null>(null)
  const harnesses = device?.harnesses.filter((entry) => entry.state !== 'disabled') ?? []
  const harness = device?.harnesses.find((entry) => entry.id === model.harness)
  const harnessName = (id: string) => device?.harnesses.find((entry) => entry.id === id)?.name ?? id
  const ownDir = model.workspaceId === null && model.cwd !== ''
  return (
    <View>
      {locked ? (
        <Text style={[styles.note, { color: c.ink3 }]}>{t('tasks.form.fixed')}</Text>
      ) : (
        <View style={styles.chips}>
          {(['newThread', 'thread'] as const).map((kind) => (
            <Chip
              key={kind}
              label={t(kind === 'newThread' ? 'tasks.form.newThread' : 'tasks.form.thread')}
              on={form.target === kind}
              onPress={() => onChange({ target: kind })}
              testID={`task:target:${kind}`}
            />
          ))}
        </View>
      )}
      {form.target === 'thread' ? (
        <Row
          testID="task:thread"
          title={
            summary
              ? t.text(summary.title)
              : form.threadId
                ? t('tasks.run.gone')
                : t('tasks.form.pickSession')
          }
          detail={[harness?.name, summary?.cwd].filter(Boolean).join(' · ') || undefined}
          onPress={locked ? undefined : () => setPicking(threadsOf(deviceId, store))}
        />
      ) : (
        <>
          {harnesses.length > 1 || locked ? (
            <>
              <Text style={[styles.label, { color: c.ink2 }]}>{t('tasks.form.harness')}</Text>
              {harnesses.map((entry) =>
                locked && entry.id !== model.harness ? null : (
                  <Row
                    key={entry.id}
                    testID={`task:harness:${entry.id}`}
                    title={`${entry.badge}  ${entry.name}`}
                    detail={
                      entry.state === 'ready'
                        ? (entry.version ?? undefined)
                        : t(`harness.state.${entry.state}`)
                    }
                    selected={entry.id === model.harness}
                    onPress={
                      !locked && entry.state === 'ready'
                        ? () =>
                            onChange({
                              harness: entry.id,
                              settings: { model: null, effort: null, permission: null },
                            })
                        : undefined
                    }
                  />
                ),
              )}
            </>
          ) : null}
          <Text style={[styles.label, { color: c.ink2 }]}>{t('tasks.form.workspace')}</Text>
          {workspaces.map((entry) => (
            <Row
              key={entry.id}
              testID={`task:where:${entry.id}`}
              title={entry.name}
              detail={entry.roots[0]}
              selected={model.workspaceId === entry.id}
              onPress={() => onChange({ workspaceId: entry.id, cwd: entry.roots[0] ?? '' })}
            />
          ))}
          <Row
            testID="task:where:dir"
            title={ownDir ? model.cwd : t('compose.new.otherDir')}
            detail={ownDir ? t('tasks.form.cwd') : undefined}
            selected={ownDir}
            onPress={() => setAsking(true)}
          />
          <View style={styles.bar}>
            <SettingsBar
              fresh
              options={model.options ? { ...model.options, plan: false } : null}
              settings={model.shown}
              onChange={(patch) => {
                const { mode: _mode, ...rest } = patch
                onChange({ settings: { ...form.settings, ...rest } })
              }}
            />
          </View>
        </>
      )}
      {problem ? <Text style={[styles.note, { color: c.err }]}>{problem}</Text> : null}
      <Prompt
        visible={asking}
        title={t('tasks.form.cwd')}
        initial={model.cwd}
        placeholder={t('tasks.form.cwdPlaceholder')}
        submitLabel={t('form.confirm')}
        onSubmit={(path) => onChange({ workspaceId: null, cwd: path.trim() })}
        onClose={() => setAsking(false)}
      />
      <PickerSheet
        visible={picking !== null}
        title={t('tasks.form.pickSession')}
        value={form.threadId}
        search={t('composer.modelSearch')}
        options={(picking ?? []).map((entry) => ({
          id: entry.id,
          title: t.text(entry.title),
          note: [harnessName(entry.harness), entry.cwd].filter(Boolean).join(' · '),
        }))}
        onPick={(id) => {
          setPicking(null)
          const picked = picking?.find((entry) => entry.id === id)
          onChange({ threadId: id, harness: picked?.harness ?? '' })
        }}
        onClose={() => setPicking(null)}
        testID="task:threads"
      />
    </View>
  )
}

const styles = StyleSheet.create({
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 6,
  },
  note: { fontSize: 13, lineHeight: 19, paddingHorizontal: 16, paddingVertical: 8 },
  bar: { paddingTop: 10 },
})
