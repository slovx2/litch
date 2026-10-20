// 模型清单这一块（照桌面端的 ModelsTab；config 说有 modelCatalog 的 harness 才有，现在只有原生 Codex）。
// 顶上：在用自带目录还是自定义清单、清单文件、改了怎么生效、对面的说明和锁住的原因。
// 自定义清单整份替换自带目录，所以“开始自定义”先把自带目录整份导成原样用的项，再删、加、改、排。
// 手机上一行放不下四个按钮：点一行出动作单（上移、下移、改、删除）；新增、改用同一张表单（ModelForm），
// 表单开着时这一页只显示它。改动攒在草稿里，底下一条“保存”；版本冲突时核心已经重读，草稿留着；
// 恢复自带目录先在界面里确认。纯逻辑用桌面那一份（packages/ui/src/devices/hconfig/models.ts）。
import type { ChannelErrorShape, HcModelEntry, HcModelsView, HcSlot } from '@litch/core'
import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { whyNot } from '../../../../../../packages/ui/src/app/errors.ts'
import { effectKey } from '../../../../../../packages/ui/src/devices/hconfig/logic.ts'
import {
  asIs,
  importAll,
  moved,
  resolved,
  sameEntries,
  shortWindow,
} from '../../../../../../packages/ui/src/devices/hconfig/models.ts'
import { useChannel } from '../../../shell/services'
import { useT } from '../../../ui/i18n'
import { Button, Chip, Row, SectionLabel } from '../../../ui/kit/controls'
import { Confirm, Sheet } from '../../../ui/kit/overlays'
import { useTheme } from '../../../ui/theme'
import { ModelForm } from './ModelForm'
import { Note, type Said, SaidNote, SlotState } from './parts'

export function ModelsTab({
  deviceId,
  harnessId,
  name,
  slot,
}: {
  deviceId: string
  harnessId: string
  /** harness 给人看的名字（“恢复 Codex 自带目录”里用） */
  name: string
  slot: HcSlot<HcModelsView>
}) {
  const theme = useTheme()
  const t = useT()
  const channel = useChannel()
  const insets = useSafeAreaInsets()
  const { c } = theme
  /** 正在改的清单；null 是没在改，照读到的显示 */
  const [draft, setDraft] = useState<HcModelEntry[] | null>(null)
  /** 表单开着：新增（index 为 null）或改第几项 */
  const [editing, setEditing] = useState<{ index: number | null } | null>(null)
  /** 点了哪一行（出动作单） */
  const [picked, setPicked] = useState<number | null>(null)
  const [asking, setAsking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<ChannelErrorShape | null>(null)
  const [said, setSaid] = useState<Said>(null)
  /** 撞上冲突时看到的版本：核心重读的结果到之前，再存还是会冲突，先不让存 */
  const [staleVersion, setStaleVersion] = useState<string | null>(null)
  /** 写成了、写之前的版本：新读到的那一份到了再收起草稿，免得先闪回旧的 */
  const [landing, setLanding] = useState<string | null>(null)
  /** 开始改的时候这一块被别处动过几次：之后又动了，提示一句 */
  const [base, setBase] = useState(slot.revision)
  const data = slot.data
  const landed = landing !== null && (data?.version !== landing || slot.error !== null)
  useEffect(() => {
    if (landing === null) return
    const settle = () => {
      setDraft(null)
      setLanding(null)
    }
    if (landed) {
      settle()
      return
    }
    const timer = setTimeout(settle, 5000)
    return () => clearTimeout(timer)
  }, [landing, landed])
  useEffect(() => {
    if (!said || said.bad) return
    const timer = setTimeout(() => setSaid(null), 5000)
    return () => clearTimeout(timer)
  }, [said])
  const editingNow = draft !== null
  useEffect(() => {
    if (!editingNow) setBase(slot.revision)
  }, [editingNow, slot.revision])

  if (!data) {
    return (
      <SlotState
        slot={slot}
        onRetry={() =>
          void channel
            .command('harnessConfig.reload', { deviceId, harness: harnessId, part: 'models' })
            .catch(() => {})
        }
      />
    )
  }

  const locked = data.readOnlyReason !== null
  const entries = draft ?? data.entries
  const dirty = draft !== null && (!data.custom || !sameEntries(draft, data.entries))
  const movedElsewhere = draft !== null && slot.revision > base
  const rereading = staleVersion !== null && data.version === staleVersion && !slot.error
  const busy = saving || landing !== null
  const effect = effectKey(data.effect)
  const showingList = data.custom || draft !== null
  const change = (next: HcModelEntry[]) => {
    setFailure(null)
    setSaid(null)
    setDraft(next)
  }

  const write = async (next: HcModelEntry[] | null) => {
    setSaving(true)
    setFailure(null)
    setSaid(null)
    setStaleVersion(null)
    try {
      const result = await channel.command('harnessConfig.models.write', {
        deviceId,
        harness: harnessId,
        entries: next,
        expectedVersion: data.version,
      })
      setLanding(data.version)
      setSaid({
        text:
          next === null
            ? t(result.restartRequired ? 'hc.models.restored.restart' : 'hc.models.restored', {
                name,
              })
            : t(result.restartRequired ? 'hc.models.saved.restart' : 'hc.models.saved', {
                count: next.length,
              }),
        bad: false,
      })
    } catch (error) {
      const shape = error as ChannelErrorShape
      if (next === null) {
        // 恢复没成：没有保存条可以挂，底下说一句
        setSaid({
          text:
            shape?.code === 'conflict'
              ? t('hc.models.conflict')
              : t('hc.failed', { reason: whyNot(shape, t) }),
          bad: true,
        })
        return
      }
      if (shape?.code === 'conflict') setStaleVersion(data.version)
      setFailure(shape)
    } finally {
      setSaving(false)
    }
  }

  const taken = (except: number | null) =>
    new Set(entries.flatMap((entry, at) => (at === except ? [] : [entry.id])))

  if (editing) {
    const index = editing.index
    return (
      <View style={styles.fill} testID="hc:tab:models">
        <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={24}>
          <ModelForm
            bases={data.bases}
            entry={index === null ? null : (entries[index] ?? null)}
            taken={taken(index)}
            onDone={(entry) => {
              change(
                index === null
                  ? [...entries, entry]
                  : entries.map((one, at) => (at === index ? entry : one)),
              )
              setEditing(null)
            }}
            onClose={() => setEditing(null)}
          />
        </KeyboardAwareScrollView>
      </View>
    )
  }

  const pickedEntry = picked === null ? null : (entries[picked] ?? null)
  const overall = failure
    ? failure.code === 'conflict'
      ? t('hc.models.conflict')
      : t('manage.save.failed', { reason: whyNot(failure, t) })
    : entries.length === 0
      ? t('hc.models.save.empty')
      : null

  return (
    <View style={styles.fill} testID="hc:tab:models">
      <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={24}>
        <SectionLabel>
          {data.custom ? t('hc.models.state.custom') : t('hc.models.state.builtin', { name })}
        </SectionLabel>
        <View style={styles.head} testID={`hc:models:state:${data.custom ? 'custom' : 'builtin'}`}>
          <Text style={[styles.small, { color: c.ink2 }]}>
            {effect ? <Text style={{ color: c.wait }}>{t(effect)} · </Text> : null}
            {data.custom
              ? t('hc.models.custom.note', { name })
              : t('hc.models.builtin.note', { name })}
          </Text>
          {data.path ? (
            <Text style={[styles.small, { color: c.ink3 }]} testID="hc:models:path">
              {data.custom ? t('hc.files') : t('hc.models.pathLater')}{' '}
              <Text selectable style={{ color: c.ink2, fontFamily: theme.font.mono }}>
                {data.path}
              </Text>
            </Text>
          ) : null}
          {data.note ? (
            <Text style={[styles.small, { color: c.ink3 }]} testID="hc:models:note">
              {t.said(data.note)}
            </Text>
          ) : null}
          {locked && data.readOnlyReason ? (
            <Text style={[styles.small, { color: c.wait }]} testID="hc:models:locked">
              {t('hc.models.locked', { reason: t.said(data.readOnlyReason) })}
            </Text>
          ) : null}
          {!showingList && !locked ? (
            <View style={styles.start}>
              <Button
                label={t('hc.models.start')}
                disabled={busy || data.bases.length === 0}
                testID="hc:models:start"
                onPress={() => change(importAll(data.bases))}
              />
              <Text style={[styles.small, { color: c.ink3 }]}>{t('hc.models.start.note')}</Text>
            </View>
          ) : null}
        </View>

        {movedElsewhere ? (
          <View style={[styles.moved, { borderColor: c.wait }]} testID="hc:models:moved">
            <Note text={t('hc.models.moved')} tone="wait" />
            <View style={styles.acts}>
              <Chip label={t('manage.conflict.keepMine')} onPress={() => setBase(slot.revision)} />
              <Chip
                label={t('manage.conflict.takeLatest')}
                testID="hc:models:takeLatest"
                onPress={() => setDraft(null)}
              />
            </View>
          </View>
        ) : null}

        <SectionLabel>
          {showingList
            ? t('hc.models.list', { count: entries.length })
            : t('hc.models.bases', { name, count: data.bases.length })}
        </SectionLabel>
        <Note
          text={
            showingList
              ? `${t('hc.models.list.note')}${locked ? '' : ` ${t('hcm.models.tap')}`}`
              : t('hc.models.bases.note')
          }
          tone="dim"
        />
        {showingList ? (
          entries.length === 0 ? (
            <Note text={t('hc.models.empty')} tone="wait" testID="hc:models:empty" />
          ) : (
            entries.map((entry, index) => {
              const shown = resolved(entry, data.bases)
              const baseName = shown.base?.displayName ?? entry.base
              const how = !shown.base
                ? t('hc.models.baseGone', { base: entry.base })
                : asIs(entry)
                  ? t('hc.models.asIs', { base: baseName })
                  : t('hc.models.basedOn', { base: baseName })
              return (
                <Row
                  key={entry.id}
                  title={shown.name}
                  meta={shown.window === null ? undefined : shortWindow(shown.window)}
                  detail={`${entry.id} · ${how}`}
                  testID={`hc:model:${entry.id}`}
                  onPress={locked || busy ? undefined : () => setPicked(index)}
                />
              )
            })
          )
        ) : (
          data.bases.map((one) => (
            <Row
              key={one.id}
              title={one.displayName}
              meta={one.contextWindow === null ? undefined : shortWindow(one.contextWindow)}
              detail={one.description ? `${one.id} · ${one.description}` : one.id}
              testID={`hc:models:base:${one.id}`}
            />
          ))
        )}
        {showingList && !locked ? (
          <View style={styles.acts}>
            <Button
              kind="plain"
              label={t('hc.models.add')}
              disabled={busy}
              testID="hc:models:add"
              onPress={() => setEditing({ index: null })}
            />
            {data.custom ? (
              <Button
                kind="danger"
                label={t('hc.models.restore', { name })}
                disabled={busy}
                testID="hc:models:restore"
                onPress={() => setAsking(true)}
              />
            ) : null}
          </View>
        ) : null}
        <View style={styles.tail} />
      </KeyboardAwareScrollView>

      {draft !== null && (dirty || failure) ? (
        <View
          style={[
            styles.saveBar,
            { borderTopColor: c.line3, backgroundColor: c.panel, paddingBottom: insets.bottom + 8 },
          ]}
          testID="hc:models:saveBar"
        >
          <Text style={[styles.count, { color: c.ink }]}>
            {data.custom
              ? t('hc.models.save.changed')
              : t('hc.models.save.start', { count: entries.length })}
          </Text>
          <Text
            style={[styles.small, { color: overall ? c.err : c.ink3 }]}
            accessibilityRole={overall ? 'alert' : undefined}
            testID={overall ? 'hc:models:failure' : undefined}
          >
            {overall ?? t('hc.models.save.note')}
          </Text>
          <View style={styles.saveActs}>
            <Button
              kind="plain"
              label={t('manage.discard')}
              disabled={busy}
              testID="hc:models:discard"
              onPress={() => {
                setDraft(null)
                setFailure(null)
              }}
            />
            <Button
              label={t(busy ? 'manage.saving' : 'manage.save')}
              busy={busy}
              disabled={rereading || entries.length === 0 || !dirty}
              testID="hc:models:save"
              onPress={() => void write(entries)}
            />
          </View>
        </View>
      ) : said ? (
        <View
          style={[
            styles.saidBar,
            { borderTopColor: c.line3, backgroundColor: c.panel, paddingBottom: insets.bottom + 4 },
          ]}
        >
          <SaidNote said={said} testID="hc:models:said" />
        </View>
      ) : null}

      <Sheet
        visible={pickedEntry !== null}
        title={pickedEntry?.id}
        actions={
          picked === null
            ? []
            : [
                ...(picked > 0
                  ? [
                      {
                        label: t('hc.models.up'),
                        testID: 'hc:model:up',
                        onPress: () => change(moved(entries, picked, -1)),
                      },
                    ]
                  : []),
                ...(picked < entries.length - 1
                  ? [
                      {
                        label: t('hc.models.down'),
                        testID: 'hc:model:down',
                        onPress: () => change(moved(entries, picked, 1)),
                      },
                    ]
                  : []),
                {
                  label: t('hc.edit'),
                  testID: 'hc:model:edit',
                  onPress: () => setEditing({ index: picked }),
                },
                {
                  label: t('hc.remove'),
                  danger: true,
                  testID: 'hc:model:remove',
                  onPress: () => change(entries.filter((_, at) => at !== picked)),
                },
              ]
        }
        onClose={() => setPicked(null)}
      />
      <Confirm
        visible={asking}
        danger
        title={t('hc.models.restore.title', { name })}
        detail={t('hc.models.restore.note', { name })}
        confirmLabel={t('hc.models.restore.yes')}
        onConfirm={() => void write(null)}
        onClose={() => setAsking(false)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  small: { fontSize: 12, lineHeight: 17 },
  head: { paddingHorizontal: 16, paddingBottom: 10, gap: 6 },
  start: { gap: 6, paddingTop: 6, alignItems: 'flex-start' },
  moved: { borderWidth: 1, margin: 12, paddingBottom: 8 },
  acts: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, padding: 16 },
  tail: { height: 24 },
  saidBar: { borderTopWidth: 1, paddingTop: 4 },
  saveBar: { borderTopWidth: 1, paddingTop: 8, paddingHorizontal: 16, gap: 4 },
  count: { fontSize: 14, fontWeight: '600' },
  saveActs: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
})
