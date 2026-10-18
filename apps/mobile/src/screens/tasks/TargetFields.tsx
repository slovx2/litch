// 表单里“到点之后”一块：每次新建会话（harness、项目或目录、模型强度权限，选择器和新建会话页的是同一套），
// 或者在一个已有会话里接着发（选会话）。编辑时种类、harness、会话改不了（协议的规矩），只写出来。
// useTargetModel 把这几栏算成协议的 TaskTarget（交给表单），TargetFields 只管画。
import {
  type DeviceView,
  keys,
  newSessionSettings,
  type SessionGroups,
  type SessionSettings,
  type SessionSummary,
  type TaskTarget,
  type WorkspaceView,
} from '@litch/core'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useComposeOptions, useNewSessionDefaults } from '../../detail/composer/options'
import { PickerSheet } from '../../detail/composer/PickerSheet'
import { SettingsBar } from '../../detail/composer/SettingsBar'
import { useKey, useReplica } from '../../shell/services'
import { type Key, useT } from '../../ui/i18n'
import { Chip, Row } from '../../ui/kit/controls'
import { Prompt } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'

export type Where = { kind: 'workspace'; id: string } | { kind: 'dir'; path: string }

export interface TargetForm {
  kind: TaskTarget['kind']
  /** 点选的 harness；null 是还没选（用可用的第一个） */
  harness: string | null
  where: Where | null
  /** 选过的模型、强度、权限 */
  picks: Partial<Omit<SessionSettings, 'mode'>>
  threadId: string | null
}

export function targetFormOf(target: TaskTarget): TargetForm {
  if (target.kind === 'thread')
    return {
      kind: 'thread',
      harness: target.harness,
      where: null,
      picks: {},
      threadId: target.threadId,
    }
  const { settings } = target
  return {
    kind: 'newThread',
    harness: target.harness,
    where: target.workspaceId
      ? { kind: 'workspace', id: target.workspaceId }
      : { kind: 'dir', path: target.cwd },
    picks: Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== null)),
    threadId: null,
  }
}

export interface TargetModel {
  /** 算出来的目标；还缺东西是 null，problem 说缺什么 */
  target: TaskTarget | null
  problem: Key | null
  harnessId: string | null
  /** 实际用的建在哪（没选时是默认的那个） */
  where: Where | null
  cwd: string | null
  /** 设置条上显示的（没选的显示对面的默认） */
  shown: SessionSettings
  options: ReturnType<typeof useComposeOptions>
}

export function useTargetModel(deviceId: string, form: TargetForm): TargetModel {
  const device = useKey<DeviceView>(keys.device(deviceId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId))
  const summary = useKey<SessionSummary>(keys.summary(deviceId, form.threadId ?? ''))
  const ready = device?.harnesses.filter((entry) => entry.state === 'ready') ?? []
  const harnessId =
    form.kind === 'thread'
      ? (summary?.harness ?? form.harness ?? null)
      : (form.harness ?? ready[0]?.id ?? null)
  // 还没选建在哪：默认第一个项目（没有项目就得自己填目录）
  const first = workspaces?.find((entry) => entry.roots[0])
  const where: Where | null = form.where ?? (first ? { kind: 'workspace', id: first.id } : null)
  const workspace =
    where?.kind === 'workspace' ? workspaces?.find((entry) => entry.id === where.id) : undefined
  const cwd = where?.kind === 'dir' ? where.path : (workspace?.roots[0] ?? null)
  const options = useComposeOptions(
    deviceId,
    form.kind === 'newThread' ? (harnessId ?? undefined) : undefined,
  )
  const defaults = useNewSessionDefaults(deviceId, harnessId ?? undefined, cwd)
  const settled = options ? newSessionSettings(form.picks, defaults, options) : null
  const shown: SessionSettings = {
    model: settled?.model ?? form.picks.model ?? null,
    effort: settled?.effort ?? form.picks.effort ?? null,
    permission: settled?.permission ?? form.picks.permission ?? null,
    mode: null,
  }
  if (form.kind === 'thread') {
    if (!form.threadId || !harnessId)
      return {
        target: null,
        problem: 'timed.bad.thread',
        harnessId,
        where,
        cwd: null,
        shown,
        options,
      }
    return {
      target: { kind: 'thread', harness: harnessId, threadId: form.threadId },
      problem: null,
      harnessId,
      where,
      cwd: null,
      shown,
      options,
    }
  }
  if (!harnessId)
    return { target: null, problem: 'newSession.noHarness', harnessId, where, cwd, shown, options }
  if (!cwd)
    return { target: null, problem: 'timed.bad.where', harnessId, where, cwd, shown, options }
  return {
    target: {
      kind: 'newThread',
      harness: harnessId,
      cwd,
      workspaceId: workspace?.id ?? null,
      // 问到了对面的默认就照显示的明着发（和新建会话页一样），没问到只发选了的
      settings: settled
        ? { model: shown.model, effort: shown.effort, permission: shown.permission }
        : {
            model: form.picks.model ?? null,
            effort: form.picks.effort ?? null,
            permission: form.picks.permission ?? null,
          },
    },
    problem: null,
    harnessId,
    where,
    cwd,
    shown,
    options,
  }
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
  onChange,
}: {
  deviceId: string
  form: TargetForm
  model: TargetModel
  /** 编辑：种类、harness、会话改不了 */
  locked: boolean
  onChange(patch: Partial<TargetForm>): void
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
  const harness = device?.harnesses.find((entry) => entry.id === model.harnessId)
  return (
    <View>
      {locked ? (
        <Text style={[styles.note, { color: c.ink3 }]}>{t('timed.target.locked')}</Text>
      ) : (
        <View style={styles.chips}>
          {(['newThread', 'thread'] as const).map((kind) => (
            <Chip
              key={kind}
              label={t(kind === 'newThread' ? 'timed.target.newThread' : 'timed.target.thread')}
              on={form.kind === kind}
              onPress={() => onChange({ kind })}
              testID={`task:target:${kind}`}
            />
          ))}
        </View>
      )}
      {form.kind === 'thread' ? (
        <Row
          testID="task:thread"
          title={
            summary
              ? t.text(summary.title)
              : form.threadId
                ? t('timed.target.thread.gone')
                : t('timed.target.thread.none')
          }
          detail={[harness?.name, summary?.cwd].filter(Boolean).join(' · ') || undefined}
          onPress={locked ? undefined : () => setPicking(threadsOf(deviceId, store))}
        />
      ) : (
        <>
          {harnesses.length > 1 || locked ? (
            <>
              <Text style={[styles.label, { color: c.ink2 }]}>{t('newSession.harness')}</Text>
              {harnesses.map((entry) =>
                locked && entry.id !== model.harnessId ? null : (
                  <Row
                    key={entry.id}
                    testID={`task:harness:${entry.id}`}
                    title={`${entry.badge}  ${entry.name}`}
                    detail={
                      entry.state === 'ready'
                        ? (entry.version ?? undefined)
                        : t(`harness.state.${entry.state}`)
                    }
                    selected={entry.id === model.harnessId}
                    onPress={
                      !locked && entry.state === 'ready'
                        ? () => onChange({ harness: entry.id, picks: {} })
                        : undefined
                    }
                  />
                ),
              )}
            </>
          ) : null}
          <Text style={[styles.label, { color: c.ink2 }]}>{t('compose.new.where')}</Text>
          {workspaces.map((entry) => (
            <Row
              key={entry.id}
              testID={`task:where:${entry.id}`}
              title={entry.name}
              detail={entry.roots[0]}
              selected={model.where?.kind === 'workspace' && model.where.id === entry.id}
              onPress={() => onChange({ where: { kind: 'workspace', id: entry.id } })}
            />
          ))}
          <Row
            testID="task:where:dir"
            title={model.where?.kind === 'dir' ? model.where.path : t('compose.new.otherDir')}
            detail={model.where?.kind === 'dir' ? t('compose.new.dir') : undefined}
            selected={model.where?.kind === 'dir'}
            onPress={() => setAsking(true)}
          />
          <View style={styles.bar}>
            <SettingsBar
              fresh
              options={model.options ? { ...model.options, plan: false } : null}
              settings={model.shown}
              onChange={(patch) => {
                const { mode: _mode, ...rest } = patch
                onChange({ picks: { ...form.picks, ...rest } })
              }}
            />
          </View>
        </>
      )}
      <Prompt
        visible={asking}
        title={t('compose.new.dirTitle')}
        initial={model.cwd ?? ''}
        placeholder={t('compose.new.dirPlaceholder')}
        submitLabel={t('form.confirm')}
        onSubmit={(path) => onChange({ where: { kind: 'dir', path: path.trim() } })}
        onClose={() => setAsking(false)}
      />
      <PickerSheet
        visible={picking !== null}
        title={t('timed.target.thread.pick')}
        value={form.threadId}
        search={t('composer.modelSearch')}
        options={(picking ?? []).map((entry) => ({
          id: entry.id,
          title: t.text(entry.title),
          note: [device?.harnesses.find((h) => h.id === entry.harness)?.name, entry.cwd]
            .filter(Boolean)
            .join(' · '),
        }))}
        onPick={(id) => {
          setPicking(null)
          const picked = picking?.find((entry) => entry.id === id)
          onChange({ threadId: id, harness: picked?.harness ?? null })
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
