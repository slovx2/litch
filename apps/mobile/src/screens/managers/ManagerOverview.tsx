// 手机经理概览，照桌面概览：现状、两个数（待用户决策、已完成）、受阻事项、请你做、最近动态；
// 末尾“经理事项 N”一节默认收起（原来单独的页签并进来，35-manager 17.3），“已完成”和 #I-n 展开它并定位到那一项。
import { type ManagerBoardTopicView, managerBoardPages } from '@litch/core'
import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type {
  ManagerActivityView,
  ManagerItemView,
} from '../../../../../packages/core/src/model-manager.mts'
import { stamp } from '../../../../../packages/ui/src/app/format.ts'
import { useT } from '../../ui/i18n'
import { Button, Row, SectionLabel } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'
import { Markdown } from './IssueMarkdown'
import { IssueRelations } from './IssueRelations'
import { collapsedMarkdown } from './presentation'

const PAGE = 10
/** 超过这么多行的动态先收起，只显示前几行。 */
const LONG_LINES = 5

function Activity({
  activity,
  onLine,
}: {
  activity: ManagerActivityView
  onLine(threadId: string, title: string): void
}) {
  const t = useT()
  const { c, radius, hit } = useTheme()
  const [expanded, setExpanded] = useState(false)
  const source = activity.source ?? { kind: 'system' as const }
  const short = collapsedMarkdown(activity.text, LONG_LINES)
  return (
    <View
      testID={`manager-activity:${activity.id}`}
      style={[styles.activity, { borderColor: c.line1 }]}
    >
      <View style={styles.activityHead}>
        {source.kind === 'line' ? (
          <Pressable
            accessibilityRole="link"
            onPress={() => onLine(source.threadId, source.title)}
            style={[styles.pill, { borderColor: c.line3, borderRadius: radius.s }]}
          >
            <Text style={{ color: c.ink2 }}>
              {t('manager.source.line')} · {source.title} ↗
            </Text>
          </Pressable>
        ) : (
          <Text
            style={[styles.pill, { color: c.ink2, borderColor: c.line1, borderRadius: radius.s }]}
          >
            {t(`manager.source.${source.kind}`)}
          </Text>
        )}
        <Text style={{ color: c.ink3 }}>{stamp(activity.at, Date.now(), t.lang)}</Text>
      </View>
      <Markdown text={short && !expanded ? `${short}\n\n…` : activity.text} />
      {short ? (
        <Pressable
          accessibilityRole="button"
          aria-expanded={expanded}
          onPress={() => setExpanded(!expanded)}
          style={[styles.toggle, { minHeight: hit }]}
        >
          <Text style={{ color: c.ink2 }}>
            {expanded ? '▾' : '▸'}{' '}
            {t(expanded ? 'manager.activityCollapse' : 'manager.activityExpand')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}

/** 受阻事项：标题一行，第二行“等待决策 #D-n”，编号是链接色、点了跳到那条决策 */
function BlockedItem({ item, onIssue }: { item: ManagerItemView; onIssue(id: string): void }) {
  const t = useT()
  const { c, font, hit } = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      testID={`overview-blocked:${item.id}`}
      onPress={() => onIssue(item.id)}
      style={({ pressed }) => [
        styles.blocked,
        {
          minHeight: hit,
          borderBottomColor: c.line1,
          backgroundColor: pressed ? c.press : c.panel,
        },
      ]}
    >
      <Text style={{ color: c.ink, fontSize: font.size.body }}>
        #{item.id} · {item.title}
      </Text>
      {item.blockedBy.length ? (
        <View style={styles.waits}>
          <Text style={{ color: c.ink2 }}>
            {t('manager.waitDecisions', { n: item.blockedBy.length })}
          </Text>
          {item.blockedBy.map((id) => (
            <Text
              key={id}
              role="link"
              testID={`overview-blocked:${item.id}:${id}`}
              onPress={() => onIssue(id)}
              style={[styles.link, { color: c.accent, minHeight: hit }]}
            >
              #{id}
            </Text>
          ))}
        </View>
      ) : null}
    </Pressable>
  )
}

/** 经理事项一行：编号、标题、状态；点开看理由和关联。定位到的那一项展开并画强调边 */
function ItemRow({ item, focused }: { item: ManagerItemView; focused: boolean }) {
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
        <Text style={{ color: c.ink2 }}>{open ? '▾' : '▸'}</Text>
        <Text
          style={{ color: c.ink, fontSize: font.size.body, flex: 1 }}
          numberOfLines={open ? 0 : 1}
        >
          #{item.id} · {item.title}
        </Text>
        <Text style={{ color: c.ink3 }}>{t(`manager.status.${item.status}`)}</Text>
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
  board,
  onDecisions,
  onItems,
  onIssue,
  onLine,
  focusItem,
  onItemsAt,
}: {
  board: NonNullable<ManagerBoardTopicView['board']>
  onDecisions(): void
  /** “已完成”：展开经理事项一节，页面滚到那里 */
  onItems(): void
  onIssue(id: string): void
  onLine(threadId: string, title: string): void
  /** 要定位的经理事项（#I-n）：展开这一节和那一项；'*' 只展开这一节 */
  focusItem: string | null
  /** 经理事项一节在概览里的纵向位置，页面据此滚过去 */
  onItemsAt(y: number): void
}) {
  const t = useT()
  const { c, font, radius, hit } = useTheme()
  const [shown, setShown] = useState(PAGE)
  const [itemsOpen, setItemsOpen] = useState(Boolean(focusItem))
  useEffect(() => {
    if (focusItem) setItemsOpen(true)
  }, [focusItem])
  const { situation, stats, requests, blocked, activities } = managerBoardPages(board).overview
  // 两个数照桌面概览：待用户决策（点进控制台的决策）、已完成（点进经理事项）
  const tiles = [
    {
      key: 'wait',
      value: stats.pendingDecisions,
      wait: stats.pendingDecisions > 0,
      onPress: onDecisions,
    },
    { key: 'done', value: stats.doneItems, wait: false, onPress: onItems },
  ] as const
  return (
    <View testID="manager-overview">
      <View style={[styles.card, { borderColor: c.line1, backgroundColor: c.panel }]}>
        <View style={styles.activityHead}>
          <Text style={{ color: c.ink, fontWeight: '600', fontSize: font.size.title, flex: 1 }}>
            {t('manager.situation')}
          </Text>
          {situation ? (
            <Text style={{ color: c.ink3 }}>{stamp(situation.at, Date.now(), t.lang)}</Text>
          ) : null}
        </View>
        <Markdown text={situation?.text ?? t('manager.none')} />
      </View>
      <View style={styles.tiles}>
        {tiles.map((tile) => (
          <Pressable
            key={tile.key}
            testID={`manager-stat:${tile.key}`}
            accessibilityRole="button"
            aria-label={`${tile.value} ${t(`manager.${tile.key}`, { n: tile.value })}`}
            onPress={tile.onPress}
            style={({ pressed }) => [
              styles.tile,
              {
                borderColor: c.line1,
                backgroundColor: pressed ? c.press : c.panel,
                borderRadius: radius.s,
              },
            ]}
          >
            <Text
              style={{
                color: tile.wait ? c.wait : c.ink,
                fontSize: font.size.title + 4,
                fontWeight: '600',
                fontFamily: font.mono,
              }}
            >
              {tile.value}
            </Text>
            <Text style={{ color: c.ink2 }}>{t(`manager.${tile.key}`, { n: tile.value })}</Text>
          </Pressable>
        ))}
      </View>
      <SectionLabel>{t('manager.blocked')}</SectionLabel>
      {blocked.length ? (
        blocked.map((item) => <BlockedItem key={item.id} item={item} onIssue={onIssue} />)
      ) : (
        <Text style={[styles.none, { color: c.ink3 }]}>{t('manager.none')}</Text>
      )}
      {requests.length ? (
        <>
          <SectionLabel>{t('manager.requests')}</SectionLabel>
          {requests.map((request) => (
            <Row
              key={request.id}
              testID={`overview-request:${request.id}`}
              title={`#${request.id} · ${request.title}`}
              detail={t(`manager.request.${request.status}`)}
              onPress={() => onIssue(request.id)}
            />
          ))}
        </>
      ) : null}
      <SectionLabel>{t('manager.activity')}</SectionLabel>
      {activities.slice(0, shown).map((activity) => (
        <Activity key={activity.id} activity={activity} onLine={onLine} />
      ))}
      {!activities.length ? (
        <Text style={[styles.none, { color: c.ink3 }]}>{t('manager.none')}</Text>
      ) : null}
      {activities.length > shown ? (
        <View style={styles.more}>
          <Button
            kind="plain"
            label={t('mgr.activity.more')}
            onPress={() => setShown(shown + PAGE * 2)}
          />
        </View>
      ) : null}
      <View onLayout={(event) => onItemsAt(event.nativeEvent.layout.y)}>
        <Pressable
          accessibilityRole="button"
          aria-expanded={itemsOpen}
          testID="overview-items"
          onPress={() => setItemsOpen(!itemsOpen)}
          style={[styles.itemsHead, { minHeight: hit, backgroundColor: c.win }]}
        >
          <Text style={{ color: c.ink2, fontSize: font.size.meta + 1, fontWeight: '600' }}>
            {itemsOpen ? '▾' : '▸'} {t('mgr.items.count', { count: board.items.length })}
          </Text>
        </Pressable>
        {itemsOpen
          ? board.items.map((item) => (
              <ItemRow key={item.id} item={item} focused={focusItem === item.id} />
            ))
          : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { padding: 16, margin: 12, borderWidth: 1, gap: 8 },
  tiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  tile: { flexGrow: 1, flexBasis: '40%', borderWidth: 1, padding: 12, gap: 2 },
  activity: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, gap: 8 },
  activityHead: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  pill: { borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2 },
  toggle: { alignSelf: 'stretch', justifyContent: 'center' },
  blocked: { paddingHorizontal: 16, paddingVertical: 8, gap: 2, borderBottomWidth: 1 },
  waits: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8 },
  link: { textAlignVertical: 'center', paddingVertical: 12 },
  none: { paddingHorizontal: 16, paddingVertical: 12 },
  more: { padding: 12 },
  itemsHead: { justifyContent: 'center', paddingHorizontal: 16 },
  item: { borderBottomWidth: 1, borderLeftWidth: 3 },
  itemHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 13 },
  itemBody: { paddingHorizontal: 16, paddingBottom: 12, gap: 8 },
})
