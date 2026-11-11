// 设备详情里的“模型等级排序”（手机）：派子会话时父会话只能派同级或更低的模型，这里排哪个模型在哪一级。
// 收着时一行标题加摘要；点开才向设备读模型清单。改动先进草稿，点“保存”才成为设备的规则。
// “跨 harness 比较等级”关着时按 harness 分组，开着时一条共用阶梯。窄屏不拖动，点一行用动作单调级。
// 规则与桌面同一份（packages/ui/src/devices/manage/ranking-view.ts）。
import { type DeviceView, keys, type ModelRankingSnapshot } from '@litch/core'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import {
  applyRank,
  crossHarnessOf,
  laddersOf,
  type RankedModel,
  unrankedOf,
  writeOf,
} from '../../../../../packages/ui/src/devices/manage/ranking-view.ts'
import type { RootStackParamList } from '../../nav/routes'
import { useChannel, useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { Confirm, Sheet } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'
import { useLeaveGuard } from './hconfig/leave'
import { LadderCard, PartialCard, rankActions, UnrankedCard } from './RankingParts'

export function ModelRanking({ device, reveal = false }: { device: DeviceView; reveal?: boolean }) {
  const deviceId = device.id
  const channel = useChannel()
  const t = useT()
  const { c, font } = useTheme()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const latest = useKey<ModelRankingSnapshot>(keys.modelRanking(deviceId))
  const [open, setOpen] = useState(reveal)
  const [draft, setDraft] = useState<ModelRankingSnapshot | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)
  const [picked, setPicked] = useState<RankedModel | null>(null)
  const [reset, setReset] = useState(false)
  useEffect(() => {
    if (latest && !dirty) setDraft(latest)
  }, [latest, dirty])
  const leave = useLeaveGuard(dirty)
  const request = async (action: 'read' | 'write' | 'reset') => {
    setBusy(true)
    setFailure(null)
    try {
      const result =
        action === 'read'
          ? await channel.command('device.modelRanking.read', { deviceId })
          : action === 'reset'
            ? await channel.command('device.modelRanking.reset', {
                deviceId,
                expectedRevision: draft?.revision ?? 0,
              })
            : draft &&
              (await channel.command('device.modelRanking.write', { deviceId, ...writeOf(draft) }))
      if (result) {
        setDraft(result)
        setDirty(false)
      }
      return Boolean(result)
    } catch (error) {
      setFailure(error)
      return false
    } finally {
      setBusy(false)
    }
  }
  leave.current = () => request('write')
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在打开的那一下读
  useEffect(() => {
    if (open && !dirty) void request('read')
  }, [open])
  useEffect(() => {
    if (reveal) setOpen(true)
  }, [reveal])

  const edit = (next: ModelRankingSnapshot) => {
    if (!draft || next === draft) return
    setDraft(next)
    setDirty(true)
  }
  const order = device.harnesses.map((entry) => entry.id)
  const cross = draft ? crossHarnessOf(draft) : false
  const summary = draft
    ? `${t(draft.mode === 'custom' ? 'ranking.custom' : 'ranking.builtin')} · ${t(
        cross ? 'ranking.across' : 'ranking.within',
      )}${dirty ? ` · ${t('ranking.unsaved')}` : ''}`
    : null
  return (
    <View testID="model-ranking" style={styles.root}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={styles.header}
        testID="ranking:toggle"
      >
        <Text style={{ color: c.ink3, fontSize: font.size.meta }}>{open ? '▾' : '▸'}</Text>
        <Text style={{ color: c.ink, fontWeight: '600', fontSize: font.size.body }}>
          {t('ranking.title')}
        </Text>
        {summary ? (
          <Text
            numberOfLines={1}
            style={[styles.summary, { color: c.ink3, fontSize: font.size.small }]}
          >
            {summary}
          </Text>
        ) : null}
      </Pressable>
      {open ? (
        <View style={styles.body}>
          <Text style={{ color: c.ink3, fontSize: font.size.small, lineHeight: 18 }}>
            {t('ranking.intro')}
          </Text>
          {failure != null ? (
            <Text accessibilityRole="alert" style={{ color: c.err, fontSize: font.size.meta }}>
              {whyNot(failure, t)}
            </Text>
          ) : null}
          {!draft ? (
            <Text style={{ color: c.ink3, fontSize: font.size.meta }}>{t('ranking.loading')}</Text>
          ) : (
            <>
              <View style={styles.switchRow}>
                <View style={styles.switchText}>
                  <Text style={{ color: c.ink, fontSize: font.size.body }}>
                    {t('ranking.cross')}
                  </Text>
                  <Text style={{ color: c.ink3, fontSize: font.size.small, lineHeight: 17 }}>
                    {t(cross ? 'ranking.cross.on' : 'ranking.cross.off')}
                  </Text>
                </View>
                <Switch
                  accessibilityLabel={t('ranking.cross')}
                  value={cross}
                  disabled={busy}
                  onValueChange={(value) => edit({ ...draft, crossHarness: value })}
                  testID="ranking:cross"
                />
              </View>
              <PartialCard
                device={device}
                errors={draft.errors}
                busy={busy}
                onReload={() => void request('read')}
                onSettings={(harness) =>
                  navigation.navigate('HarnessSettings', { deviceId, harness })
                }
              />
              {laddersOf(draft, order).map((ladder) => (
                <LadderCard
                  key={ladder.harness ?? 'all'}
                  device={device}
                  ladder={ladder}
                  disabled={busy}
                  onPick={setPicked}
                />
              ))}
              <UnrankedCard
                device={device}
                models={unrankedOf(draft, order)}
                disabled={busy}
                onPick={setPicked}
              />
              {draft.models.length === 0 ? (
                <Text style={{ color: c.ink3, fontSize: font.size.meta }}>
                  {t('ranking.empty')}
                </Text>
              ) : null}
              <View style={styles.foot}>
                <Button
                  label={t('ranking.save')}
                  disabled={busy || !dirty}
                  onPress={() => void request('write')}
                  testID="ranking:save"
                />
                {dirty ? (
                  <Button
                    kind="plain"
                    label={t('ranking.discard')}
                    disabled={busy}
                    onPress={() => {
                      setDirty(false)
                      setDraft(latest ?? null)
                      if (!latest) void request('read')
                    }}
                    testID="ranking:discard"
                  />
                ) : null}
                <Button
                  kind="plain"
                  label={t('ranking.reset')}
                  disabled={busy || (draft.mode === 'builtin' && !cross)}
                  onPress={() => setReset(true)}
                  testID="ranking:reset"
                />
                <Button
                  kind="plain"
                  label={t('ranking.refresh')}
                  disabled={busy}
                  onPress={() => void request('read')}
                  testID="ranking:reload"
                />
              </View>
              <Sheet
                visible={picked !== null}
                title={picked?.name ?? ''}
                actions={
                  picked
                    ? rankActions(draft, picked, t, (action) =>
                        edit({ ...draft, ...applyRank(draft, picked.key, action) }),
                      )
                    : []
                }
                onClose={() => setPicked(null)}
              />
              <Confirm
                visible={reset}
                title={t('ranking.reset')}
                detail={t('ranking.resetNote')}
                confirmLabel={t('ranking.resetConfirm')}
                onConfirm={() => void request('reset')}
                onClose={() => setReset(false)}
              />
            </>
          )}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { paddingHorizontal: 16, paddingVertical: 12, gap: 10 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 },
  summary: { flex: 1, minWidth: 0 },
  body: { gap: 12 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  switchText: { flex: 1, minWidth: 0, gap: 2 },
  foot: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
})
