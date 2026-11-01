// 手机经理概览，照桌面概览：现状、几个数、请你做、受阻事项、最近动态。
import {
  type ManagerBoardTopicView,
  type ManagerView,
  managerAttentionCount,
  managerBoardPages,
} from '@litch/core'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { ManagerActivityView } from '../../../../../packages/core/src/model-manager.mts'
import { stamp } from '../../../../../packages/ui/src/app/format.ts'
import { useT } from '../../ui/i18n'
import { Button, Row, SectionLabel } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'
import { Markdown } from './IssueMarkdown'
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
  const { c, radius } = useTheme()
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
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(!expanded)}
          style={styles.toggle}
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

export function ManagerOverview({
  manager,
  board,
  onConsole,
  onItems,
  onIssue,
  onLine,
}: {
  manager: ManagerView
  board: NonNullable<ManagerBoardTopicView['board']>
  onConsole(): void
  onItems(): void
  onIssue(id: string): void
  onLine(threadId: string, title: string): void
}) {
  const t = useT()
  const { c, font, radius } = useTheme()
  const [shown, setShown] = useState(PAGE)
  const { situation, stats, requests, blocked, activities } = managerBoardPages(board).overview
  const attention = manager.status === 'active' ? managerAttentionCount(manager) : 0
  const tiles = [
    { key: 'pending', value: String(attention), wait: attention > 0, onPress: onConsole },
    {
      key: 'blocked',
      value: String(stats.blockedItems),
      wait: stats.blockedItems > 0,
      onPress: onItems,
    },
    { key: 'lines', value: String(stats.runningLines), wait: false, onPress: undefined },
    { key: 'done', value: `${stats.doneItems}/${stats.totalItems}`, wait: false, onPress: onItems },
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
            accessibilityRole={tile.onPress ? 'button' : undefined}
            disabled={!tile.onPress}
            onPress={tile.onPress}
            style={[
              styles.tile,
              { borderColor: c.line1, backgroundColor: c.panel, borderRadius: radius.s },
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
            <Text style={{ color: c.ink2 }}>{t(`manager.stat.${tile.key}`)}</Text>
          </Pressable>
        ))}
      </View>
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
      <SectionLabel>{t('manager.blocked')}</SectionLabel>
      {blocked.length ? (
        blocked.map((item) => (
          <Row
            key={item.id}
            title={`#${item.id} · ${item.title}`}
            detail={item.blockedBy.map((id) => `#${id}`).join(' ') || undefined}
            onPress={() => onIssue(item.id)}
          />
        ))
      ) : (
        <Text style={[styles.none, { color: c.ink3 }]}>{t('manager.none')}</Text>
      )}
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
  toggle: { alignSelf: 'flex-start', paddingVertical: 4 },
  none: { paddingHorizontal: 16, paddingVertical: 12 },
  more: { padding: 12 },
})
