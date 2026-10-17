// 设备详情里的 harness 与设置：开着这一页才订阅这台设备的管理数据（replica.openManage，manage 主题）。
// 每个 harness 一块：标题行是徽标、名字、版本、状态、启用开关（设备服务标了 role: 'enable' 的那一项，不认键名），
// 点开是原因和它的各项设置；设备级的设置按分组各一块。改了的先记草稿，一块一个“保存”，一次写入全有或全无；
// 别处先改过了（版本号对不上）就不写，换成最新的值并说明。要重启才生效的，标出待重启，由用户点“重启”。
import {
  type ChannelErrorShape,
  type DeviceView,
  type HarnessView,
  keys,
  type ManageSchema,
  type SettingEditView,
  type SettingSpecView,
  type SettingsSnapshotView,
  type SettingsWriteResult,
} from '@litch/core'
import { type ReactNode, useEffect, useState } from 'react'
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import { useBusy, useChannel, useKey, useReplica } from '../../shell/services'
import { type Translator, useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { Confirm } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'
import { type Draft, editOf, problemOf, SettingControl } from './SettingControl'

function harnessLine(harness: HarnessView, t: Translator): string {
  const state =
    harness.state === 'ready'
      ? t('harness.state.ready')
      : harness.state === 'disabled'
        ? t('harness.state.disabled')
        : t('harness.state.unavailable')
  return [harness.version, state, harness.reason ? t.text(harness.reason) : null]
    .filter(Boolean)
    .join(' · ')
}

/** 只读的 harness 列表：对面没有设置接口、或者没连着的时候 */
export function HarnessList({ device }: { device: DeviceView }) {
  const theme = useTheme()
  const t = useT()
  return device.harnesses.map((harness) => (
    <View key={harness.id} style={styles.head} testID={`harness:${harness.id}`}>
      <Text style={[styles.badge, { color: theme.c.ink, borderColor: theme.c.line2 }]}>
        {harness.badge}
      </Text>
      <View style={styles.grow}>
        <Text style={[styles.name, { color: theme.c.ink }]}>{harness.name}</Text>
        <Text style={[styles.small, { color: theme.c.ink2 }]}>{harnessLine(harness, t)}</Text>
      </View>
    </View>
  ))
}

interface BlockProps {
  deviceId: string
  /** harness 标识换成给人看的名字 */
  nameOf(id: string): string
  title: string
  specs: SettingSpecView[]
  snapshot: SettingsSnapshotView
  drafts: Record<string, Draft>
  setDraft(key: string, draft: Draft): void
  clear(keys: string[]): void
  /** 默认收着；有草稿的那一块自己开着 */
  header?: ReactNode
  testID: string
}

/** 一块设置：点标题展开，里面有草稿时出“保存” */
function Block({
  deviceId,
  nameOf,
  title,
  specs,
  snapshot,
  drafts,
  setDraft,
  clear,
  header,
  testID,
}: BlockProps) {
  const theme = useTheme()
  const t = useT()
  const channel = useChannel()
  const [open, setOpen] = useState(false)
  const [saving, run] = useBusy()
  const [said, setSaid] = useState<{ text: string; bad: boolean } | null>(null)
  const dirty = specs.filter((spec) => drafts[spec.key] !== undefined)
  const shown = open || dirty.length > 0
  const save = async () => {
    setSaid(null)
    if (dirty.some((spec) => problemOf(spec, drafts[spec.key], t))) {
      setSaid({ text: t('manage.save.fix'), bad: true })
      return
    }
    const edits = dirty
      .map((spec) => editOf(spec, drafts[spec.key]))
      .filter((edit): edit is SettingEditView => edit !== null)
    try {
      const result: SettingsWriteResult = await run(
        channel.command('device.settings.write', {
          deviceId,
          expectedVersion: snapshot.version,
          edits,
        }),
      )
      clear(dirty.map((spec) => spec.key))
      setSaid({
        text:
          result.pendingRestart.length > 0
            ? t('manage.saved.pending', { names: result.pendingRestart.map(nameOf).join('、') })
            : result.restarted.length > 0
              ? t('manage.saved.restarted', { names: result.restarted.map(nameOf).join('、') })
              : t('manage.saved'),
        bad: false,
      })
    } catch (failed) {
      const conflict = (failed as { code?: string } | null)?.code === 'conflict'
      if (conflict) clear(dirty.map((spec) => spec.key))
      setSaid({
        text: conflict
          ? t('manage.save.conflict')
          : t('manage.save.failed', { reason: whyNot(failed, t) }),
        bad: true,
      })
    }
  }
  return (
    <View style={[styles.block, { borderBottomColor: theme.c.line1 }]} testID={testID}>
      {header}
      {specs.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setOpen(!open)}
          testID={`${testID}:fold`}
        >
          <Text style={[styles.fold, { color: theme.c.ink2 }]}>
            {shown ? '▾' : '▸'} {title}
          </Text>
        </Pressable>
      ) : null}
      {shown
        ? specs.map((spec) => (
            <SettingControl
              key={spec.key}
              spec={spec}
              value={snapshot.values[spec.key] ?? null}
              draft={drafts[spec.key]}
              onDraft={(next) => setDraft(spec.key, next)}
            />
          ))
        : null}
      {dirty.length > 0 ? (
        <View style={styles.save}>
          <Button
            kind="plain"
            label={t('manage.discard')}
            onPress={() => clear(dirty.map((spec) => spec.key))}
          />
          <Button
            label={t('manage.save')}
            busy={saving}
            testID={`${testID}:save`}
            onPress={() => void save()}
          />
        </View>
      ) : null}
      {said ? (
        <Text style={[styles.note, { color: said.bad ? theme.c.err : theme.c.ok }]}>
          {said.text}
        </Text>
      ) : null}
    </View>
  )
}

/** 一个 harness 的标题行：启用开关（立刻写）、重启 */
function HarnessHead({
  deviceId,
  harness,
  enable,
  snapshot,
}: {
  deviceId: string
  harness: HarnessView
  enable: SettingSpecView | null
  snapshot: SettingsSnapshotView
}) {
  const theme = useTheme()
  const t = useT()
  const channel = useChannel()
  const [writing, runWrite] = useBusy()
  const [restarting, runRestart] = useBusy()
  const [busyAsk, setBusyAsk] = useState(false)
  const [said, setSaid] = useState<{ text: string; bad: boolean } | null>(null)
  const pending = snapshot.pendingRestart.includes(harness.id)
  const on = enable ? snapshot.values[enable.key] === true : null
  const toggle = async (next: boolean) => {
    if (!enable) return
    setSaid(null)
    try {
      await runWrite(
        channel.command('device.settings.write', {
          deviceId,
          expectedVersion: snapshot.version,
          edits: [{ key: enable.key, value: next }],
        }),
      )
    } catch (failed) {
      setSaid({ text: t('manage.save.failed', { reason: whyNot(failed, t) }), bad: true })
    }
  }
  const restart = async (force: boolean) => {
    setSaid(null)
    try {
      const result = await runRestart(
        channel.command('device.harness.restart', { deviceId, harness: harness.id, force }),
      )
      setSaid(
        result.running
          ? { text: t('manage.restart.done', { name: harness.name }), bad: false }
          : {
              text: t('manage.restart.down', {
                name: harness.name,
                reason: result.text ? t.said(result.text) : '',
              }),
              bad: true,
            },
      )
    } catch (failed) {
      if (!force && (failed as { code?: string } | null)?.code === 'busy') {
        setBusyAsk(true)
        return
      }
      setSaid({
        text: t('manage.restart.failed', { name: harness.name, reason: whyNot(failed, t) }),
        bad: true,
      })
    }
  }
  return (
    <View>
      <View style={styles.head} testID={`harness:${harness.id}`}>
        <Text style={[styles.badge, { color: theme.c.ink, borderColor: theme.c.line2 }]}>
          {harness.badge}
        </Text>
        <View style={styles.grow}>
          <Text style={[styles.name, { color: theme.c.ink }]}>
            {harness.name}
            {pending ? <Text style={{ color: theme.c.wait }}> · {t('manage.pending')}</Text> : null}
          </Text>
          <Text style={[styles.small, { color: theme.c.ink2 }]}>{harnessLine(harness, t)}</Text>
        </View>
        {enable && on !== null ? (
          <Switch
            accessibilityLabel={t('devices.manage.enable')}
            testID={`harness:${harness.id}:enable`}
            value={on}
            disabled={writing}
            onValueChange={(next) => void toggle(next)}
            trackColor={{ true: theme.c.accent, false: theme.c.line2 }}
          />
        ) : null}
      </View>
      <View style={styles.actions}>
        <Button
          kind={pending ? 'solid' : 'plain'}
          label={restarting ? t('manage.restarting') : t('manage.restart')}
          busy={restarting}
          disabled={on === false}
          testID={`harness:${harness.id}:restart`}
          onPress={() => void restart(false)}
        />
      </View>
      {pending ? (
        <Text style={[styles.note, { color: theme.c.wait }]}>
          {t('manage.pending.note', { name: harness.name })}
        </Text>
      ) : null}
      {said ? (
        <Text style={[styles.note, { color: said.bad ? theme.c.err : theme.c.ok }]}>
          {said.text}
        </Text>
      ) : null}
      <Confirm
        visible={busyAsk}
        danger
        title={t('manage.restart.busy.title', { name: harness.name })}
        detail={t('manage.restart.busy.note')}
        confirmLabel={t('manage.restart.busy.yes')}
        onConfirm={() => void restart(true)}
        onClose={() => setBusyAsk(false)}
      />
    </View>
  )
}

const belongsTo = (spec: SettingSpecView, harness: string) =>
  spec.scope.kind === 'harness' && spec.scope.harness === harness

export function ManageSection({ device }: { device: DeviceView }) {
  const replica = useReplica()
  const theme = useTheme()
  const t = useT()
  const deviceId = device.id
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 变了就是要重新订阅
  useEffect(() => replica.openManage(deviceId), [replica, deviceId, attempt])
  const schema = useKey<ManageSchema>(keys.manage(deviceId))
  const snapshot = useKey<SettingsSnapshotView>(keys.manageSnapshot(deviceId))
  const error = useKey<ChannelErrorShape>(keys.manageError(deviceId))
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  if (error) {
    return (
      <View style={styles.block}>
        <Text style={[styles.note, { color: theme.c.err }]}>
          {t('manage.unreadable', { reason: whyNot(error, t) })}
        </Text>
        <View style={styles.actions}>
          <Button kind="plain" label={t('app.retry')} onPress={() => setAttempt((n) => n + 1)} />
        </View>
      </View>
    )
  }
  if (!schema || !snapshot) {
    return <Text style={[styles.note, { color: theme.c.ink3 }]}>{t('manage.loading')}</Text>
  }
  const setDraft = (key: string, draft: Draft) =>
    setDrafts((before) => {
      const next = { ...before }
      if (draft === undefined) delete next[key]
      else next[key] = draft
      return next
    })
  const clear = (keys: string[]) =>
    setDrafts((before) => {
      const next = { ...before }
      for (const key of keys) delete next[key]
      return next
    })
  const nameOf = (id: string) => device.harnesses.find((harness) => harness.id === id)?.name ?? id
  const shared = { deviceId, nameOf, snapshot, drafts, setDraft, clear }
  const deviceSpecs = schema.settings.filter((spec) => spec.scope.kind === 'device')
  const groups = schema.groups.filter((group) => group.scope.kind === 'device')
  const loose = deviceSpecs.filter((spec) => !groups.some((group) => group.id === spec.group))
  return (
    <View testID="manage">
      {device.harnesses.map((harness) => {
        const specs = schema.settings.filter((spec) => belongsTo(spec, harness.id))
        const enable =
          specs.find((spec) => spec.role === 'enable' && spec.type === 'boolean') ?? null
        const rest = specs.filter((spec) => spec !== enable)
        return (
          <Block
            key={harness.id}
            {...shared}
            testID={`manage:${harness.id}`}
            title={t('devices.manage.settings', { count: rest.length })}
            specs={rest}
            header={
              <HarnessHead
                deviceId={deviceId}
                harness={harness}
                enable={enable}
                snapshot={snapshot}
              />
            }
          />
        )
      })}
      {groups.map((group) => {
        const specs = deviceSpecs.filter((spec) => spec.group === group.id)
        if (specs.length === 0) return null
        return (
          <Block
            key={group.id}
            {...shared}
            testID={`manage:group:${group.id}`}
            title={t.said(group.title)}
            specs={specs}
          />
        )
      })}
      {loose.length > 0 ? (
        <Block
          {...shared}
          testID="manage:group:other"
          title={t('manage.group.other')}
          specs={loose}
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  block: { borderBottomWidth: 1, paddingBottom: 8 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  badge: { borderWidth: 1, paddingHorizontal: 4, fontSize: 12, fontWeight: '700' },
  grow: { flex: 1, minWidth: 0 },
  name: { fontSize: 15, fontWeight: '600' },
  small: { fontSize: 12, lineHeight: 17 },
  fold: { fontSize: 13, paddingHorizontal: 16, paddingVertical: 8 },
  actions: { flexDirection: 'row', gap: 10, paddingHorizontal: 16 },
  save: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, paddingHorizontal: 16 },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingVertical: 6 },
})
