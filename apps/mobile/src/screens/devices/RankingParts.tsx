// 手机的模型等级排序页里的几块：一条阶梯、未分级区、读不到的 harness。规则与桌面同一份
// （packages/ui/src/devices/manage/ranking-view.ts）。窄屏不拖动：点一行弹出动作单调级。
import type { DeviceView, ModelRankingConfig } from '@litch/core'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import {
  canRank,
  type Ladder,
  ladderFor,
  listOf,
  type RankAction,
  type RankedModel,
  readFailureOf,
} from '../../../../../packages/ui/src/devices/manage/ranking-view.ts'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import type { SheetAction } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'

const badgeOf = (device: DeviceView | undefined, id: string) =>
  device?.harnesses.find((entry) => entry.id === id)?.badge ?? id.slice(0, 2).toUpperCase()

function Badge({ label }: { label: string }) {
  const { c, font, radius } = useTheme()
  return (
    <Text
      style={[
        styles.badge,
        { color: c.ink2, borderColor: c.line2, borderRadius: radius.s, fontFamily: font.mono },
      ]}
    >
      {label}
    </Text>
  )
}

/** 调级动作单里的几项：现在做不了的不列（手机的灰项要写原因，这里没有值得写的） */
export function rankActions(
  draft: ModelRankingConfig,
  model: RankedModel,
  t: ReturnType<typeof useT>,
  run: (action: RankAction) => void,
): SheetAction[] {
  const ranked = !draft.unranked.includes(model.key)
  const others = ladderFor(draft, model).levels.filter(
    (level) => !level.members.some((member) => member.key === model.key),
  )
  type Item = [label: string, action: RankAction, value?: string]
  const items: Item[] = [
    ...(ranked
      ? [
          [t('ranking.menu.up'), { kind: 'up' }] satisfies Item,
          [t('ranking.menu.down'), { kind: 'down' }] satisfies Item,
          [t('ranking.menu.split'), { kind: 'split' }] satisfies Item,
        ]
      : [
          [t('ranking.menu.top'), { kind: 'top' }] satisfies Item,
          [t('ranking.menu.bottom'), { kind: 'bottom' }] satisfies Item,
        ]),
    ...others.map(
      (level): Item => [
        t('ranking.menu.join', { level: level.number }),
        { kind: 'join', tier: level.tier },
        level.members.map((member) => member.name).join(' · '),
      ],
    ),
    ...(ranked ? [[t('ranking.menu.unrank'), { kind: 'unrank' }] satisfies Item] : []),
  ]
  return items
    .filter(([, action]) => canRank(draft, model.key, action))
    .map(([label, action, value]) => ({
      label,
      onPress: () => run(action),
      testID: `ranking:action:${action.kind}${action.kind === 'join' ? `:${action.tier}` : ''}`,
      ...(value ? { value } : {}),
    }))
}

/** 一个模型一行：点了弹调级动作单 */
function RankRow({
  device,
  model,
  badge,
  disabled,
  onPick,
}: {
  device: DeviceView | undefined
  model: RankedModel
  badge: boolean
  disabled: boolean
  onPick(model: RankedModel): void
}) {
  const { c, font, hit } = useTheme()
  const t = useT()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('ranking.handle', { model: model.name })}
      disabled={disabled}
      onPress={() => onPick(model)}
      testID={`ranking:model:${model.model}`}
      style={({ pressed }) => [
        styles.row,
        { minHeight: hit - 8, backgroundColor: pressed ? c.press : 'transparent' },
      ]}
    >
      <Text
        numberOfLines={1}
        style={[
          styles.name,
          {
            color: model.available ? c.ink : c.ink3,
            fontSize: font.size.body,
            fontFamily: font.ui,
          },
        ]}
      >
        {model.name}
      </Text>
      {model.available ? null : (
        <Text style={{ color: c.ink3, fontSize: font.size.small }}>{t('ranking.unavailable')}</Text>
      )}
      {badge ? <Badge label={badgeOf(device, model.harness)} /> : null}
      <Text style={{ color: c.ink3, fontSize: font.size.meta }}>⋯</Text>
    </Pressable>
  )
}

export function LadderCard({
  device,
  ladder,
  disabled,
  onPick,
}: {
  device: DeviceView | undefined
  ladder: Ladder
  disabled: boolean
  onPick(model: RankedModel): void
}) {
  const { c, font, radius } = useTheme()
  const t = useT()
  return (
    <View
      style={[
        styles.card,
        { borderColor: c.line2, borderRadius: radius.l, backgroundColor: c.raised },
      ]}
      testID={`ranking:ladder:${ladder.harness ?? 'all'}`}
    >
      {ladder.harness ? (
        <View style={[styles.head, { borderColor: c.line1 }]}>
          <Badge label={badgeOf(device, ladder.harness)} />
          <Text style={{ color: c.ink, fontWeight: '600', fontSize: font.size.meta }}>
            {t.harness(
              ladder.harness,
              device?.harnesses.find((entry) => entry.id === ladder.harness)?.name,
            )}
          </Text>
          <Text style={{ color: c.ink3, fontSize: font.size.small }}>
            {t('ranking.levels', { count: ladder.levels.length })}
          </Text>
        </View>
      ) : null}
      {ladder.levels.map((level, index) => (
        <View
          key={level.tier}
          style={[
            styles.level,
            index > 0 || ladder.harness
              ? { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.line1 }
              : null,
          ]}
        >
          <Text style={[styles.levelNum, { color: c.ink3, fontSize: font.size.small }]}>
            {t('ranking.level', { level: level.number })}
          </Text>
          <View style={styles.levelRows}>
            {level.members.map((model) => (
              <RankRow
                key={model.key}
                device={device}
                model={model}
                badge={ladder.harness === null}
                disabled={disabled}
                onPick={onPick}
              />
            ))}
          </View>
        </View>
      ))}
    </View>
  )
}

export function UnrankedCard({
  device,
  models,
  disabled,
  onPick,
}: {
  device: DeviceView | undefined
  models: RankedModel[]
  disabled: boolean
  onPick(model: RankedModel): void
}) {
  const { c, font, radius } = useTheme()
  const t = useT()
  if (models.length === 0) return null
  return (
    <View
      style={[styles.card, styles.dashed, { borderColor: c.line2, borderRadius: radius.l }]}
      testID="ranking:unranked"
    >
      <View style={[styles.head, { borderColor: c.line1 }]}>
        <Text style={{ color: c.ink, fontWeight: '600', fontSize: font.size.meta }}>
          {t('ranking.unranked')}
        </Text>
        <Text style={{ color: c.ink3, fontSize: font.size.small }}>{models.length}</Text>
      </View>
      <Text style={[styles.note, { color: c.ink3, fontSize: font.size.small }]}>
        {t('ranking.unknownNote')}
      </Text>
      <View style={styles.unrankedRows}>
        {models.map((model) => (
          <RankRow
            key={model.key}
            device={device}
            model={model}
            badge
            disabled={disabled}
            onPick={onPick}
          />
        ))}
      </View>
    </View>
  )
}

/** 读不到模型的几个 harness：是哪个、为什么、去哪里处理 */
export function PartialCard({
  device,
  errors,
  busy,
  onReload,
  onSettings,
}: {
  device: DeviceView | undefined
  errors: Record<string, string>
  busy: boolean
  onReload(): void
  onSettings(harnessId: string): void
}) {
  const { c, font, radius } = useTheme()
  const t = useT()
  const failed = Object.keys(errors)
  if (failed.length === 0) return null
  const harnesses = device?.harnesses ?? []
  const nameOf = (id: string) => t.harness(id, harnesses.find((entry) => entry.id === id)?.name)
  return (
    <View
      style={[
        styles.partial,
        { borderColor: c.line2, borderRadius: radius.l, backgroundColor: c.panel },
      ]}
      testID="ranking:partial"
    >
      <Text style={{ color: c.ink, fontWeight: '500', fontSize: font.size.meta }}>
        {t('ranking.partial.title', { harnesses: listOf(failed.map(nameOf), t.lang) })}
      </Text>
      {failed.map((id) => {
        const harness = harnesses.find((entry) => entry.id === id)
        const kind = readFailureOf(id, harnesses)
        const reason =
          kind === 'unavailable' && harness?.reason
            ? t.text(harness.reason)
            : t(`ranking.partial.${kind}`)
        return (
          <View key={id} style={styles.partialRow}>
            <Badge label={badgeOf(device, id)} />
            <View style={styles.partialText}>
              <Text style={{ color: c.ink, fontSize: font.size.meta }}>{nameOf(id)}</Text>
              <Text style={{ color: c.ink3, fontSize: font.size.small }}>{reason}</Text>
            </View>
            {harness ? (
              <Button
                kind="plain"
                label={t('ranking.partial.settings')}
                onPress={() => onSettings(id)}
                testID={`ranking:settings:${id}`}
              />
            ) : null}
          </View>
        )
      })}
      <Text style={{ color: c.ink3, fontSize: font.size.small }}>{t('ranking.partial.note')}</Text>
      <Button kind="plain" label={t('ranking.refresh')} disabled={busy} onPress={onReload} />
    </View>
  )
}

const styles = StyleSheet.create({
  badge: {
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 4,
    fontSize: 10,
    lineHeight: 15,
    overflow: 'hidden',
  },
  card: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  dashed: { borderStyle: 'dashed' },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  level: { flexDirection: 'row', paddingLeft: 12, paddingRight: 4, paddingVertical: 2 },
  levelNum: { width: 52, paddingTop: 10 },
  levelRows: { flex: 1, minWidth: 0 },
  unrankedRows: { paddingLeft: 12, paddingRight: 4, paddingBottom: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 6,
  },
  name: { flex: 1, minWidth: 0 },
  note: { paddingHorizontal: 12, paddingTop: 6, lineHeight: 17 },
  partial: { borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 8 },
  partialRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  partialText: { flex: 1, minWidth: 0 },
})
