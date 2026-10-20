// 提案的“改了再开始”：单独一页（字段多、要打字，底部弹层放不下也躲不开键盘）。照提案预填，
// harness、模型、强度、项目、目录、权限、全新还是带上下文、标题、简报、完成后唤醒都能改；
// 开始时只把和提案不一样的几项放进 overrides（logic.ts 的 overridesFor，初值和改动用桌面 spawn-form.ts 那一份）。
// 沙箱照样收紧到不宽于父会话，目标 harness 收不紧时写明；带上下文只能用父会话的 harness。成了就回到对话。
import {
  type DeviceView,
  keys,
  proposalStatus,
  type SessionProposalView,
  type SessionSummary,
  type WorkspaceView,
} from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useState, useSyncExternalStore } from 'react'
import { Keyboard, StyleSheet, Switch, Text, View } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import { EFFORT_TEXT } from '../../../../../packages/ui/src/composer/efforts.ts'
import {
  SANDBOX_CHOICES,
  SANDBOX_LEVEL,
  widerLevel,
} from '../../../../../packages/ui/src/tree/sandbox.ts'
import {
  fieldsFor,
  kindOf,
  type SpawnFields,
} from '../../../../../packages/ui/src/tree/spawn-form.ts'
import { useComposeOptions } from '../../detail/composer/options'
import { type PickerOption, PickerSheet } from '../../detail/composer/PickerSheet'
import { useProposalList, useSessionStore } from '../../detail/proposals/hooks'
import { overridesFor, STATUS_TEXT } from '../../detail/proposals/logic'
import type { RootStackParamList } from '../../nav/routes'
import { useBusy, useChannel, useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button, Chip, Empty, Field, Row } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { titleOf } from '../sessions/rows'

type Props = NativeStackScreenProps<RootStackParamList, 'ProposalStart'>

type Picking = 'harness' | 'model' | 'effort' | 'workspace' | 'sandbox'

export function ProposalStartScreen({ route, navigation }: Props) {
  const { deviceId, sessionId, proposalId } = route.params
  const t = useT()
  const list = useProposalList(deviceId, sessionId)
  const parent = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  // 打开时的那一份（会话存储刚开、列表还没到时，到了的第一份）：之后它被开始、不要、撤回了，表单不跟着变，
  // 开始的按钮停用并说明
  const latest = list?.find((entry) => entry.id === proposalId)
  const [proposal, setProposal] = useState(latest)
  if (!proposal && latest) setProposal(latest)
  if (!proposal || !parent) {
    return (
      <Screen title={t('proposal.edit.title')} testID="proposal-start">
        <Empty title={t('proposals.start.gone')} />
      </Screen>
    )
  }
  return (
    <StartForm
      deviceId={deviceId}
      parent={parent}
      proposal={proposal}
      latest={latest}
      onDone={() => navigation.goBack()}
    />
  )
}

function StartForm({
  deviceId,
  parent,
  proposal,
  latest,
  onDone,
}: {
  deviceId: string
  parent: SessionSummary
  proposal: SessionProposalView
  latest: SessionProposalView | undefined
  onDone(): void
}) {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const channel = useChannel()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId)) ?? []
  // 父会话的权限档从会话存储取（手机上数据副本不开会话，keys.settings 是空的）
  const parentStore = useSessionStore(deviceId, parent.id)
  const parentPermission = useSyncExternalStore(
    parentStore.subscribeMeta,
    () => parentStore.getMeta()?.settings.permission ?? null,
  )
  const [fields, setFields] = useState<SpawnFields>(() => fieldsFor(parent, proposal))
  const set = (patch: Partial<SpawnFields>) => setFields((now) => ({ ...now, ...patch }))
  const [picking, setPicking] = useState<Picking | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, run] = useBusy()
  const options = useComposeOptions(deviceId, fields.harness)
  const models = options?.models ?? []
  const model = models.find((entry) => entry.id === fields.model)
  const ready = (device?.harnesses ?? []).filter((entry) => entry.state === 'ready')
  const nameOf = (id: string) => device?.harnesses.find((entry) => entry.id === id)?.name ?? id
  const sameHarness = fields.harness === parent.harness
  const shownKind = kindOf(fields, parent)
  const wider = widerLevel(
    parentPermission,
    (options?.permissions ?? []).map((preset) => preset.id),
    fields.sandbox || null,
  )
  const status = latest ? proposalStatus(latest, Date.now()) : 'withdrawn'
  const blocked =
    status !== 'pending'
      ? t('proposals.start.settled', { state: t(STATUS_TEXT[status]) })
      : device?.connection !== 'online'
        ? t('tasks.detail.offline')
        : null
  const text = fields.prompt.trim()
  const effortName = (id: string) => {
    const key = EFFORT_TEXT[id]
    return key ? t(key) : id
  }
  const workspaceName = workspaces.find((entry) => entry.id === fields.workspaceId)?.name

  const start = async () => {
    Keyboard.dismiss()
    if (!text || blocked) return
    setFailure(null)
    try {
      await run(
        channel.command('session.proposal.accept', {
          deviceId,
          sessionId: parent.id,
          proposalId: proposal.id,
          overrides: overridesFor(fields, parent, proposal),
        }),
      )
      onDone()
    } catch (error) {
      setFailure(t('proposal.failed', { reason: whyNot(error, t) }))
    }
  }

  const picker = ((): { title: string; value: string; options: PickerOption[] } | null => {
    switch (picking) {
      case 'harness':
        return {
          title: t('tree.dialog.harness'),
          value: fields.harness,
          // 提案里写的 harness 现在不可用：照样列着，选着它开始由设备进程说行不行
          options: [
            ...(ready.some((entry) => entry.id === fields.harness)
              ? []
              : [{ id: fields.harness, title: nameOf(fields.harness) }]),
            ...ready.map((entry) => ({ id: entry.id, title: `${entry.badge}  ${entry.name}` })),
          ],
        }
      case 'model':
        return {
          title: t('tree.dialog.model'),
          value: fields.model,
          options: [
            { id: '', title: t('tree.dialog.modelDefault') },
            ...(fields.model && !model ? [{ id: fields.model, title: fields.model }] : []),
            ...models.map((entry) => ({ id: entry.id, title: entry.title, note: entry.note })),
          ],
        }
      case 'effort':
        return {
          title: t('tree.dialog.effort'),
          value: fields.effort,
          options: [
            { id: '', title: t('tree.dialog.modelDefault') },
            ...(model?.efforts ?? []).map((effort) => ({
              id: effort.id,
              title: effortName(effort.id),
            })),
          ],
        }
      case 'workspace':
        return {
          title: t('tree.dialog.workspace'),
          value: fields.workspaceId,
          options: [
            { id: '', title: t('workspace.none') },
            ...workspaces.map((entry) => ({
              id: entry.id,
              title: entry.name,
              note: entry.roots[0] ?? null,
            })),
          ],
        }
      case 'sandbox':
        return {
          title: t('tree.dialog.sandbox'),
          value: fields.sandbox,
          options: [
            { id: '', title: t('tree.dialog.sandboxParent') },
            ...SANDBOX_CHOICES.map((level) => ({ id: level, title: t(SANDBOX_LEVEL[level]) })),
          ],
        }
      case null:
        return null
    }
  })()
  const pick = (id: string) => {
    if (picking === 'harness') set({ harness: id, model: '', effort: '' })
    else if (picking === 'model') set({ model: id, effort: '' })
    else if (picking === 'effort') set({ effort: id })
    else if (picking === 'workspace') set({ workspaceId: id })
    else if (picking === 'sandbox') set({ sandbox: id as SpawnFields['sandbox'] })
    setPicking(null)
  }

  return (
    <Screen
      title={t('proposal.edit.title')}
      subtitle={proposal.title}
      wire={device ? c.wire[device.wire] : undefined}
      testID="proposal-start"
    >
      <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={24}>
        <Row title={titleOf(parent, t)} detail={t('proposals.start.from')} />
        <Row
          testID="proposal-start:harness"
          title={`${device?.harnesses.find((entry) => entry.id === fields.harness)?.badge ?? ''}  ${nameOf(fields.harness)}`.trim()}
          detail={t('tree.dialog.harness')}
          onPress={() => setPicking('harness')}
        />
        {wider ? (
          <Text style={[styles.note, { color: c.wait }]} testID="proposal-start:wider">
            {t('tree.spawn.wider', {
              harness: nameOf(fields.harness),
              level: t(SANDBOX_LEVEL[wider]),
            })}
          </Text>
        ) : null}
        <Row
          testID="proposal-start:model"
          title={model?.title ?? (fields.model || t('tree.dialog.modelDefault'))}
          detail={t('tree.dialog.model')}
          onPress={() => setPicking('model')}
        />
        {model && model.efforts.length > 0 ? (
          <Row
            testID="proposal-start:effort"
            title={fields.effort ? effortName(fields.effort) : t('tree.dialog.modelDefault')}
            detail={t('tree.dialog.effort')}
            onPress={() => setPicking('effort')}
          />
        ) : null}
        {workspaces.length > 0 ? (
          <Row
            testID="proposal-start:workspace"
            title={workspaceName ?? t('workspace.none')}
            detail={t('tree.dialog.workspace')}
            onPress={() => setPicking('workspace')}
          />
        ) : null}
        <Row
          testID="proposal-start:sandbox"
          title={fields.sandbox ? t(SANDBOX_LEVEL[fields.sandbox]) : t('tree.dialog.sandboxParent')}
          detail={t('tree.dialog.sandbox')}
          onPress={() => setPicking('sandbox')}
        />
        <View style={styles.fields}>
          <Field
            label={t('tree.dialog.cwd')}
            value={fields.cwd}
            placeholder={parent.cwd}
            onChangeText={(cwd) => set({ cwd })}
            testID="proposal-start:cwd"
          />
          <View style={styles.kind}>
            <Text style={[styles.label, { color: c.ink2 }]}>{t('tree.dialog.kind')}</Text>
            <View style={styles.chips}>
              <Chip
                label={t('tree.dialog.fresh')}
                on={shownKind === 'fresh'}
                onPress={() => set({ kind: 'fresh' })}
                testID="proposal-start:kind:fresh"
              />
              <Chip
                label={t('proposal.fork')}
                on={shownKind === 'fork'}
                disabled={!sameHarness}
                onPress={() => set({ kind: 'fork' })}
                testID="proposal-start:kind:fork"
              />
            </View>
            {sameHarness ? null : (
              <Text style={[styles.hint, { color: c.ink3 }]}>{t('tree.dialog.forkOnly')}</Text>
            )}
          </View>
          <Field
            label={t('tree.dialog.name')}
            value={fields.title}
            onChangeText={(title) => set({ title })}
            autoCorrect
            testID="proposal-start:title"
          />
          <Field
            label={t('tree.dialog.prompt')}
            value={fields.prompt}
            onChangeText={(prompt) => set({ prompt })}
            multiline
            autoCorrect
            testID="proposal-start:prompt"
          />
        </View>
        <View style={styles.switchRow}>
          <Text style={[styles.switchText, { color: c.ink }]}>{t('tree.dialog.wake')}</Text>
          <Switch
            testID="proposal-start:wake"
            value={fields.wake}
            onValueChange={(wake) => set({ wake })}
          />
        </View>
        {blocked ? (
          <Text style={[styles.note, { color: c.err }]} testID="proposal-start:blocked">
            {blocked}
          </Text>
        ) : null}
        {failure ? <Text style={[styles.note, { color: c.err }]}>{failure}</Text> : null}
        <View style={styles.save}>
          <Button
            label={t('proposal.start')}
            testID="proposal-start:go"
            busy={busy}
            disabled={!text || blocked !== null}
            onPress={() => void start()}
          />
        </View>
      </KeyboardAwareScrollView>
      <PickerSheet
        visible={picker !== null}
        title={picker?.title ?? ''}
        value={picker?.value ?? null}
        options={picker?.options ?? []}
        search={picking === 'model' ? t('composer.modelSearch') : undefined}
        onPick={pick}
        onClose={() => setPicking(null)}
        testID="proposal-start:picker"
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  fields: { gap: 14, padding: 16 },
  kind: { gap: 6 },
  label: { fontSize: 13, fontWeight: '500' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  hint: { fontSize: 12 },
  note: { fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingVertical: 8 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  switchText: { fontSize: 15, flex: 1 },
  save: { padding: 16 },
})
