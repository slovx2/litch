// 展开的子会话共用正式会话存储与请求卡片，不在父会话伪造答复消息。
// 样子同待答问题（PendingQuestions.tsx）：等待色的边、◆ 标题行点了收起；一个停着的子会话一行
// （徽标、标题、在等什么、“打开子会话”），点开把它的请求卡画在这张卡里（CardNested：不再套一层边框）。
// 代答记录同系统消息（CompactRow）：标题行写几条、最近一条是谁代答的，收着时下面一行是最近一条的问答
import {
  type DeviceView,
  keys,
  type SessionChildren,
  type SessionDelegatedResponse,
  type SessionSummary,
} from '@litch/core'
import { useCallback, useState, useSyncExternalStore } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { badgeOf } from '../../../../../packages/ui/src/app/device.ts'
import { stamp } from '../../../../../packages/ui/src/app/format.ts'
import { delegatedPairs } from '../../../../../packages/ui/src/composer/delegated-response'
import { useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { Answer } from '../asks/AskCell'
import { CompactRow } from '../CompactRow'
import { useSessionStore } from '../proposals/hooks'
import { CardNested } from './Card'
import { RequestSlot } from './RequestSlot'

export function ChildRequests({
  deviceId,
  sessionId,
  onOpen,
}: {
  deviceId: string
  sessionId: string
  onOpen(id: string): void
}) {
  const theme = useTheme()
  const { c, font } = theme
  const t = useT()
  const children = useKey<SessionChildren>(keys.children(deviceId))?.[sessionId] ?? []
  const waiting = useWaiting(deviceId, children)
  const [expanded, setExpanded] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  if (waiting === 0) return null
  return (
    <View
      testID="child-requests"
      style={[
        styles.frame,
        { backgroundColor: c.raised, borderColor: c.wait, borderRadius: theme.radius.l },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={({ pressed }) => [styles.head, { opacity: pressed ? 0.7 : 1 }]}
      >
        <Text style={[styles.mark, { color: c.wait }]}>◆</Text>
        <Text style={[styles.grow, { color: c.ink2, fontSize: font.size.meta }]}>
          {t('ask.childrenCount', { count: waiting })}
        </Text>
        <Text style={{ color: c.ink3, fontSize: font.size.meta }}>{expanded ? '▾' : '▸'}</Text>
      </Pressable>
      {expanded
        ? children.map((id) => (
            <Child
              key={id}
              deviceId={deviceId}
              id={id}
              open={selected === id}
              toggle={() => setSelected(selected === id ? null : id)}
              onOpen={onOpen}
            />
          ))
        : null}
    </View>
  )
}

/** 停着在等人的子会话有几个（标题行的数）：一次订阅这几个子会话的摘要，只在数变了的时候重画 */
function useWaiting(deviceId: string, children: readonly string[]): number {
  const { store } = useReplica()
  const ids = children.join('\n')
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = ids
        .split('\n')
        .filter(Boolean)
        .map((id) => store.subscribe(keys.summary(deviceId, id), listener))
      return () => {
        for (const stop of stops) stop()
      }
    },
    [store, deviceId, ids],
  )
  const count = useCallback(
    () =>
      ids
        .split('\n')
        .filter(
          (id) =>
            id && store.get<SessionSummary>(keys.summary(deviceId, id))?.pendingRequests?.length,
        ).length,
    [store, deviceId, ids],
  )
  return useSyncExternalStore(subscribe, count)
}

function Child({
  deviceId,
  id,
  open,
  toggle,
  onOpen,
}: {
  deviceId: string
  id: string
  open: boolean
  toggle(): void
  onOpen(id: string): void
}) {
  const child = useKey<SessionSummary>(keys.summary(deviceId, id))
  const device = useKey<DeviceView>(keys.device(deviceId))
  const t = useT()
  const theme = useTheme()
  const { c, font } = theme
  if (!child?.pendingRequests?.length) return null
  return (
    <View style={[styles.child, { borderTopColor: c.line1 }]}>
      <View style={styles.line}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={toggle}
          style={({ pressed }) => [styles.toggle, pressed ? { backgroundColor: c.press } : null]}
        >
          <Text
            style={[
              styles.badge,
              { color: c.ink2, borderColor: c.line2, fontFamily: font.mono, borderRadius: 3 },
            ]}
          >
            {badgeOf(device, child.harness)}
          </Text>
          <Text
            numberOfLines={1}
            style={[styles.title, { color: c.ink, fontSize: font.size.meta + 1 }]}
          >
            {t.text(child.title)}
          </Text>
          <Text
            numberOfLines={1}
            style={[styles.grow, { color: c.ink2, fontFamily: font.mono, fontSize: 12 }]}
          >
            {child.pendingRequests[0]?.title}
          </Text>
          <Text style={{ color: c.ink3, fontSize: font.size.meta }}>{open ? '▾' : '▸'}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => onOpen(id)}
          hitSlop={8}
          style={styles.open}
        >
          <Text style={{ color: c.accent, fontSize: font.size.meta }}>{t('tree.child.open')}</Text>
        </Pressable>
      </View>
      {open ? (
        <CardNested.Provider value>
          <OpenChild deviceId={deviceId} sessionId={id} />
        </CardNested.Provider>
      ) : null}
    </View>
  )
}

function OpenChild({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const store = useSessionStore(deviceId, sessionId)
  return <RequestSlot store={store} maxHeight={280} onRevise={() => {}} requestsOnly />
}

export function DelegatedHistory({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const records =
    useKey<SessionSummary>(keys.summary(deviceId, sessionId))?.delegatedResponses ?? []
  const latest = records.at(-1)
  if (!latest) return null
  const by = (record: SessionDelegatedResponse) =>
    t(record.parent ? 'ask.delegatedParent' : 'ask.delegatedSession', {
      name: record.sourceTitle || record.sourceThreadId,
    })
  return (
    <CompactRow
      testID="delegated-history"
      mark="⇄"
      source={t('ask.delegatedHistory', { count: records.length })}
      title={open ? undefined : by(latest)}
      summary={delegatedPairs(latest, t)
        .map((pair) => `${pair.question} → ${pair.answer}`)
        .join(' · ')}
      open={open}
      onPress={() => setOpen(!open)}
    >
      {/* 记录多了在这里滚，不把对话挤没 */}
      <ScrollView style={styles.records} nestedScrollEnabled>
        {records.map((record) => (
          <Record key={record.id} record={record} by={by(record)} />
        ))}
      </ScrollView>
    </CompactRow>
  )
}

function Record({ record, by }: { record: SessionDelegatedResponse; by: string }) {
  const t = useT()
  const { c, font } = useTheme()
  return (
    <View style={styles.record}>
      <Text numberOfLines={1} style={{ color: c.ink3, fontSize: font.size.small }}>
        {by} · {stamp(record.at, Date.now(), t.lang)}
      </Text>
      {delegatedPairs(record, t).map((pair, at) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 记录写下之后不会变
        <View key={at} style={styles.pair}>
          <Text selectable style={{ color: c.ink, fontSize: font.size.meta + 1, lineHeight: 19 }}>
            {pair.question}
          </Text>
          <Answer text={pair.answer} />
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  frame: { marginHorizontal: 8, marginBottom: 6, borderWidth: 1, borderLeftWidth: 3 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, height: 36 },
  mark: { fontSize: 12 },
  grow: { flex: 1 },
  child: { borderTopWidth: StyleSheet.hairlineWidth },
  line: { flexDirection: 'row', alignItems: 'center', paddingRight: 12 },
  toggle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 40,
    paddingLeft: 12,
    paddingRight: 8,
  },
  badge: { borderWidth: 1, paddingHorizontal: 4, fontSize: 11, lineHeight: 16 },
  title: { flexShrink: 1, maxWidth: '40%', fontWeight: '600' },
  open: { paddingVertical: 6 },
  records: { maxHeight: 280 },
  record: { gap: 6, paddingVertical: 6 },
  pair: { gap: 4 },
})
