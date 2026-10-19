// 配置这一块（照桌面端的 ConfigTab）：按对面声明的分组摆配置项，每组后面是这一组的动作（要先确认的先问）。
// 一项一块：标题、改了之后怎么生效、只读、说明、默认值、控件、恢复默认，被更高一层盖住时实际生效的值。
// 改过的攒在一起，底下一条“保存”（全有或全无）；版本对不上时核心已经重读，改动留着，看着最新的再保存。
// 别处改了这一块（收到通知、重读了），手上又有没保存的改动：提示一句，可以保留自己的、或者用最新的。
import type {
  ChannelErrorShape,
  HcAction,
  HcConfigView,
  HcSettingSpec,
  HcSlot,
  HcValue,
} from '@litch/core'
import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { whyNot } from '../../../../../../packages/ui/src/app/errors.ts'
import {
  effectKey,
  type HcDraft,
  type Parsed,
  parseDraft,
  sameAsStored,
} from '../../../../../../packages/ui/src/devices/hconfig/logic.ts'
import { useChannel } from '../../../shell/services'
import { useT } from '../../../ui/i18n'
import { Button, Chip, SectionLabel } from '../../../ui/kit/controls'
import { Confirm } from '../../../ui/kit/overlays'
import { useTheme } from '../../../ui/theme'
import { HcControl, isInline } from './HcControl'
import { groupsOf, valueText } from './logic'
import { Files, Note, type Said, SaidNote, SlotState } from './parts'

export function ConfigTab({
  deviceId,
  harnessId,
  slot,
}: {
  deviceId: string
  harnessId: string
  slot: HcSlot<HcConfigView>
}) {
  const theme = useTheme()
  const t = useT()
  const channel = useChannel()
  const insets = useSafeAreaInsets()
  const { c } = theme
  const [drafts, setDrafts] = useState<Record<string, HcDraft>>({})
  const [saving, setSaving] = useState(false)
  /** 保存没成：哪一项（null 是整体）、为什么 */
  const [failure, setFailure] = useState<{ key: string | null; error: ChannelErrorShape } | null>(
    null,
  )
  const [said, setSaid] = useState<Said>(null)
  /** 开始改的时候这一块被别处动过几次：之后又动了，提示一句 */
  const [base, setBase] = useState(slot.revision)
  const [asking, setAsking] = useState<HcAction | null>(null)
  /** 撞上冲突时看到的版本：核心重读的结果到之前，再存还是会冲突，先不让存 */
  const [staleVersion, setStaleVersion] = useState<string | null>(null)
  /** 写成了、写之前的版本：新读到的那一份到了再收起改动，不然控件会先闪回旧值。迟迟不到也收起 */
  const [landing, setLanding] = useState<string | null>(null)
  const data = slot.data
  const dirty = Object.keys(drafts)
  const landed = landing !== null && (data?.version !== landing || slot.error !== null)
  useEffect(() => {
    if (landing === null) return
    const settle = () => {
      setDrafts({})
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
  useEffect(() => {
    if (dirty.length === 0) setBase(slot.revision)
  }, [dirty.length, slot.revision])
  const moved = dirty.length > 0 && slot.revision > base

  if (!data) {
    return (
      <SlotState
        slot={slot}
        onRetry={() =>
          void channel
            .command('harnessConfig.reload', { deviceId, harness: harnessId, part: 'config' })
            .catch(() => {})
        }
      />
    )
  }

  const edit = (spec: HcSettingSpec, draft: HcDraft | null) => {
    setFailure(null)
    setSaid(null)
    setDrafts((current) => {
      const next = { ...current }
      if (draft === null || sameAsStored(spec, draft, data.values[spec.key])) delete next[spec.key]
      else next[spec.key] = draft
      return next
    })
  }
  const parsed: Record<string, Parsed> = {}
  for (const key of dirty) {
    const spec = data.settings.find((one) => one.key === key)
    const draft = drafts[key]
    if (spec && draft) parsed[key] = parseDraft(spec, draft)
  }
  const wrong = Object.values(parsed).some((one) => !one.ok)
  const rereading = staleVersion !== null && data.version === staleVersion && !slot.error
  const busy = saving || landing !== null

  const save = async () => {
    const edits = Object.entries(parsed).flatMap(([key, one]) =>
      one.ok ? [{ key, value: one.value }] : [],
    )
    if (wrong || rereading || edits.length === 0) return
    setSaving(true)
    setFailure(null)
    setSaid(null)
    setStaleVersion(null)
    try {
      const result = await channel.command('harnessConfig.write', {
        deviceId,
        harness: harnessId,
        edits,
        expectedVersion: data.version,
      })
      setLanding(data.version)
      setSaid({
        text: t(result.restartRequired ? 'hc.saved.restart' : 'hc.saved', { count: edits.length }),
        bad: false,
      })
    } catch (error) {
      const shape = error as ChannelErrorShape
      // 版本冲突：核心在重读这一块，改动留着，看着最新的再保存
      if (shape?.code === 'conflict') setStaleVersion(data.version)
      setFailure({ key: shape?.code === 'conflict' ? null : (shape?.key ?? null), error: shape })
    } finally {
      setSaving(false)
    }
  }

  const runAction = async (action: HcAction) => {
    setSaid(null)
    const name = t.said(action.title)
    try {
      await channel.command('harnessConfig.action', {
        deviceId,
        harness: harnessId,
        actionId: action.id,
      })
      setSaid({ text: t('hc.action.done', { name }), bad: false })
    } catch (error) {
      setSaid({ text: t('hc.action.failed', { name, reason: whyNot(error, t) }), bad: true })
    }
  }

  const overall =
    failure && failure.key === null
      ? failure.error.code === 'conflict'
        ? t('hc.conflict')
        : t('manage.save.failed', { reason: whyNot(failure.error, t) })
      : wrong
        ? t('manage.save.fix')
        : null

  return (
    <View style={styles.fill} testID="hc:tab:config">
      <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={24}>
        {moved ? (
          <View style={[styles.moved, { borderColor: c.wait }]} testID="hc:moved">
            <Note text={t('hc.moved')} tone="wait" />
            <View style={styles.acts}>
              <Chip label={t('manage.conflict.keepMine')} onPress={() => setBase(slot.revision)} />
              <Chip
                label={t('manage.conflict.takeLatest')}
                testID="hc:takeLatest"
                onPress={() => setDrafts({})}
              />
            </View>
          </View>
        ) : null}
        {groupsOf(data, t('manage.group.other')).map(({ group, specs, actions }) => (
          <View key={group.id} testID={`hc:group:${group.id || 'other'}`}>
            <SectionLabel>{t.said(group.title)}</SectionLabel>
            {group.description ? <Note text={t.said(group.description)} tone="dim" /> : null}
            {specs.map((spec) => (
              <ConfigRow
                key={spec.key}
                spec={spec}
                data={data}
                draft={drafts[spec.key]}
                parsed={parsed[spec.key]}
                refused={failure?.key === spec.key ? failure.error : null}
                saving={busy}
                onDraft={(draft) => edit(spec, draft)}
              />
            ))}
            {actions.map((action) => (
              <View key={action.id} style={styles.action}>
                <Button
                  kind={action.danger ? 'danger' : 'plain'}
                  label={t.said(action.title)}
                  testID={`hc:action:${action.id}`}
                  onPress={() => (action.confirm ? setAsking(action) : void runAction(action))}
                />
                {action.description ? (
                  <Text style={[styles.small, { color: c.ink3 }]}>
                    {t.said(action.description)}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        ))}
        <Files files={data.files} />
      </KeyboardAwareScrollView>
      {dirty.length === 0 && said ? (
        // 存好了、动作做完了：底下说一句（用户多半滚在页面中间，说在页尾看不见）
        <View
          style={[
            styles.saidBar,
            { borderTopColor: c.line3, backgroundColor: c.panel, paddingBottom: insets.bottom + 4 },
          ]}
        >
          <SaidNote said={said} testID="hc:config:said" />
        </View>
      ) : null}
      {dirty.length > 0 ? (
        <View
          style={[
            styles.saveBar,
            { borderTopColor: c.line3, backgroundColor: c.panel, paddingBottom: insets.bottom + 8 },
          ]}
          testID="hc:saveBar"
        >
          <Text style={[styles.count, { color: c.ink }]}>
            {t('manage.save.count', { count: dirty.length })}
          </Text>
          {overall ? <Note text={overall} tone="err" testID="hc:save:failure" /> : null}
          <View style={styles.saveActs}>
            <Button
              kind="plain"
              label={t('manage.discard')}
              disabled={busy}
              testID="hc:discard"
              onPress={() => setDrafts({})}
            />
            <Button
              label={t(busy ? 'manage.saving' : 'manage.save')}
              busy={busy}
              disabled={wrong || rereading}
              testID="hc:save"
              onPress={() => void save()}
            />
          </View>
        </View>
      ) : null}
      <Confirm
        visible={asking !== null}
        danger={asking?.danger}
        title={asking ? t.said(asking.title) : ''}
        detail={asking?.confirm ? t.said(asking.confirm) : undefined}
        confirmLabel={t('hc.action.yes')}
        onConfirm={() => {
          if (asking) void runAction(asking)
        }}
        onClose={() => setAsking(null)}
      />
    </View>
  )
}

interface RowProps {
  spec: HcSettingSpec
  data: HcConfigView
  draft: HcDraft | undefined
  parsed: Parsed | undefined
  refused: ChannelErrorShape | null
  saving: boolean
  onDraft(draft: HcDraft | null): void
}

function ConfigRow({ spec, data, draft, parsed, refused, saving, onDraft }: RowProps) {
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  const stored: HcValue | undefined = data.values[spec.key]
  const written = spec.key in data.values
  const overridden = data.overridden[spec.key]
  const effect = effectKey(spec.effect)
  const problem = parsed && !parsed.ok ? parsed.problem : null
  const inline = isInline(spec)
  const tid = `hc:key:${spec.key}`
  const action = draft ? (
    <Chip
      label={t('manage.revert')}
      disabled={saving}
      testID={`${tid}:revert`}
      onPress={() => onDraft(null)}
    />
  ) : written && spec.clearable && !spec.readOnly ? (
    <Chip
      label={t(spec.type === 'secret' ? 'manage.secret.clear' : 'manage.reset')}
      disabled={saving}
      testID={`${tid}:clear`}
      onPress={() => onDraft({ kind: 'clear' })}
    />
  ) : null
  const range =
    (spec.type === 'integer' || spec.type === 'number') &&
    spec.minimum !== null &&
    spec.maximum !== null
      ? t('manage.range', { minimum: spec.minimum, maximum: spec.maximum })
      : null
  const control = (
    <HcControl
      spec={spec}
      stored={stored}
      draft={draft}
      disabled={saving}
      wrong={problem !== null}
      testID={tid}
      onDraft={onDraft}
    />
  )
  const line = (text: string, color: string, testID?: string) => (
    <Text testID={testID} style={[styles.small, { color }]}>
      {text}
    </Text>
  )
  return (
    <View
      style={[
        styles.row,
        { borderBottomColor: c.line1 },
        draft ? { borderLeftColor: c.accent, borderLeftWidth: 3 } : null,
      ]}
      testID={`${tid}:row`}
    >
      <View style={styles.head}>
        <Text style={[styles.title, { color: c.ink }]}>
          {t.said(spec.title)}
          {effect ? <Text style={{ color: c.wait }}> · {t(effect)}</Text> : null}
          {spec.readOnly ? <Text style={{ color: c.ink3 }}> · {t('hc.readOnly')}</Text> : null}
        </Text>
        {inline ? control : action}
      </View>
      {spec.description || range
        ? line(
            [spec.description ? t.said(spec.description) : '', range ?? ''].join(' ').trim(),
            c.ink3,
          )
        : null}
      {!written && spec.default !== null && spec.type !== 'boolean' && spec.type !== 'secret'
        ? line(t('hc.default', { value: valueText(spec, spec.default, t) }), c.ink3)
        : null}
      {inline ? null : control}
      {inline && action ? <View style={styles.rowActs}>{action}</View> : null}
      {draft?.kind === 'clear'
        ? line(t('manage.reset.pending', { value: valueText(spec, spec.default, t) }), c.wait)
        : null}
      {overridden
        ? line(
            t('hc.overridden', {
              value: valueText(spec, overridden.value, t),
              by: t.said(overridden.by),
            }),
            c.wait,
            `${tid}:overridden`,
          )
        : null}
      {spec.readOnly && spec.readOnlyReason ? line(t.said(spec.readOnlyReason), c.ink3) : null}
      {problem ? line(t(problem), c.err, `${tid}:problem`) : null}
      {refused ? line(whyNot(refused, t), c.err, `${tid}:refused`) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  small: { fontSize: 12, lineHeight: 17 },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { flex: 1, fontSize: 15, fontWeight: '500' },
  rowActs: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  action: { paddingHorizontal: 16, paddingVertical: 8, gap: 4, alignItems: 'flex-start' },
  moved: { borderWidth: 1, margin: 12, paddingBottom: 8 },
  acts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16 },
  saidBar: { borderTopWidth: 1, paddingTop: 4 },
  saveBar: { borderTopWidth: 1, paddingTop: 8, paddingHorizontal: 16, gap: 4 },
  count: { fontSize: 14, fontWeight: '600' },
  saveActs: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
})
