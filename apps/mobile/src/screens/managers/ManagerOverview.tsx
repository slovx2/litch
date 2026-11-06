// 手机经理概览，照桌面概览：上面一行控制台四类的未完成数（点了到控制台那一类），下面是经理维护的现状正文。
// 时间线不再画（数据照旧随看板返回）。手机没有单独的经理事项页签，事项留在末尾一节，默认收起，#I-n 展开并定位。

import { type ReactNode, useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import type { ManagerItemView } from '../../../../../packages/core/src/model-manager.mts'
import type { ManagerPost } from '../../../../../packages/protocol/src/manager-posts.mjs'
import { stamp } from '../../../../../packages/ui/src/app/format.ts'
import { useT } from '../../ui/i18n'
import { Caret, Fold, Icon } from '../../ui/kit/Icon'
import { plainLine } from '../../ui/plain-text'
import { useTheme } from '../../ui/theme'
import { Markdown } from './IssueMarkdown'
import { IssueRelations } from './IssueRelations'

export type OverviewCategory = ManagerPost['kind']
export type OverviewCounts = Record<OverviewCategory, { pending: number; total: number }>

const CATEGORIES = {
  decision: 'manager.decisions',
  request: 'manager.requests',
  report: 'manager.reports',
  suggestion: 'manager.suggestions',
} as const
/** 比这窄（320 一类的小屏）四格排成两行 */
const NARROW = 360

/** 经理事项一行：编号、标题、状态；点开看理由和关联。定位到的那一项展开并画强调边 */
export function ItemRow({ item, focused }: { item: ManagerItemView; focused: boolean }) {
  const t = useT()
  const { c, font, hit } = useTheme()
  const [open, setOpen] = useState(focused)
  useEffect(() => {
    if (focused) setOpen(true)
  }, [focused])
  return (
    <View
      testID={`overview-item:${item.id}`}
      style={[
        styles.item,
        { borderBottomColor: c.line1, borderLeftColor: focused ? c.accent : 'transparent' },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        aria-expanded={open}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [
          styles.itemHead,
          { minHeight: hit, backgroundColor: pressed ? c.press : 'transparent' },
        ]}
      >
        <Caret open={open} />
        <Text
          style={{ color: c.ink, fontSize: font.size.body, flex: 1 }}
          numberOfLines={open ? 0 : 1}
        >
          <Text style={{ color: c.ink3 }}>#{item.id}</Text> {plainLine(item.title)}
        </Text>
        <Text style={{ color: c.ink3, fontSize: font.size.meta }}>
          {t(`manager.status.${item.status}`)}
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.itemBody}>
          <IssueRelations id={item.id} kind="item" />
          <Markdown text={item.why} />
        </View>
      ) : null}
    </View>
  )
}

export function ManagerOverview({
  situation,
  counts,
  onCategory,
  refresh,
  children,
}: {
  situation: { text: string; at: number } | null
  counts: OverviewCounts
  onCategory(category: OverviewCategory): void
  /** 分页看板才有：重读摘要 */
  refresh?: { busy: boolean; run(): void }
  /** 末尾的经理事项一节 */
  children?: ReactNode
}) {
  const t = useT()
  const { c, font, radius, hit } = useTheme()
  const { width } = useWindowDimensions()
  return (
    <View testID="manager-overview">
      <View style={styles.counts}>
        {(Object.keys(CATEGORIES) as OverviewCategory[]).map((key) => {
          const { pending, total } = counts[key]
          const label = t(CATEGORIES[key])
          return (
            <Pressable
              key={key}
              testID={`overview-count:${key}`}
              accessibilityRole="button"
              aria-label={`${label} · ${t('manager.overviewCount', { pending, total })}`}
              onPress={() => onCategory(key)}
              style={({ pressed }) => [
                styles.count,
                {
                  flexBasis: width < NARROW ? '45%' : '22%',
                  minHeight: hit,
                  borderRadius: radius.s,
                  borderColor: pending ? c.wait : c.line1,
                  backgroundColor: pressed ? c.press : pending ? c.raised : 'transparent',
                },
              ]}
            >
              <Text numberOfLines={1} style={{ color: pending ? c.ink : c.ink2, flexShrink: 1 }}>
                {label}
              </Text>
              <Text
                testID={`overview-count-value:${key}`}
                style={{
                  color: pending ? c.wait : c.ink3,
                  fontFamily: font.mono,
                  fontWeight: pending ? '700' : '400',
                }}
              >
                {pending}
              </Text>
            </Pressable>
          )
        })}
      </View>
      <View
        testID="overview-situation"
        style={[
          styles.card,
          { borderColor: c.line1, backgroundColor: c.raised, borderRadius: radius.m },
        ]}
      >
        <View style={[styles.cardHead, { borderBottomColor: c.line1 }]}>
          <Text style={{ color: c.ink2, fontWeight: '600', fontSize: font.size.meta, flex: 1 }}>
            {t('manager.situation')}
          </Text>
          {situation ? (
            <Text style={{ color: c.ink3, fontSize: font.size.meta }}>
              {t('manager.situationAt')} {stamp(situation.at, Date.now(), t.lang)}
            </Text>
          ) : null}
          {refresh ? (
            <Pressable
              testID="overview-refresh"
              accessibilityRole="button"
              aria-label={t('manager.paging.refresh')}
              aria-busy={refresh.busy}
              disabled={refresh.busy}
              onPress={refresh.run}
              hitSlop={8}
              style={({ pressed }) => [
                styles.refresh,
                { borderRadius: radius.s, backgroundColor: pressed ? c.press : 'transparent' },
              ]}
            >
              <Icon name="reload" size={16} color={refresh.busy ? c.ink3 : c.ink2} />
            </Pressable>
          ) : null}
        </View>
        {situation?.text ? (
          <Markdown situation text={situation.text} />
        ) : (
          <Text style={{ color: c.ink3 }}>{t('manager.situationEmpty')}</Text>
        )}
      </View>
      {children}
    </View>
  )
}

/** 经理事项一节（整份看板用）：默认收起，#I-n 定位时展开 */
export function OverviewItems({
  items,
  focusItem,
  onItemsAt,
}: {
  items: readonly ManagerItemView[]
  /** 要定位的经理事项（#I-n）：展开这一节和那一项；'*' 只展开这一节 */
  focusItem: string | null
  /** 这一节在概览里的纵向位置，页面据此滚过去 */
  onItemsAt(y: number): void
}) {
  const t = useT()
  const { c, font } = useTheme()
  const [open, setOpen] = useState(Boolean(focusItem))
  useEffect(() => {
    if (focusItem) setOpen(true)
  }, [focusItem])
  return (
    <View onLayout={(event) => onItemsAt(event.nativeEvent.layout.y)}>
      <Fold
        open={open}
        testID="overview-items"
        onToggle={() => setOpen(!open)}
        style={[styles.itemsHead, { backgroundColor: c.win }]}
      >
        <Text style={{ color: c.ink2, fontSize: font.size.meta + 1, fontWeight: '600' }}>
          {t('mgr.items.count', { count: items.length })}
        </Text>
      </Fold>
      {open
        ? items.map((item) => <ItemRow key={item.id} item={item} focused={focusItem === item.id} />)
        : null}
    </View>
  )
}

const styles = StyleSheet.create({
  counts: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 12,
    paddingTop: 12,
  },
  count: {
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    borderWidth: 1,
    paddingHorizontal: 10,
  },
  card: { margin: 12, paddingHorizontal: 16, paddingBottom: 16, borderWidth: 1, gap: 10 },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  refresh: { paddingHorizontal: 6, paddingVertical: 2 },
  itemsHead: { justifyContent: 'center', paddingHorizontal: 16 },
  item: { borderBottomWidth: 1, borderLeftWidth: 3 },
  itemHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 13 },
  itemBody: { paddingHorizontal: 16, paddingBottom: 12, gap: 8 },
})
