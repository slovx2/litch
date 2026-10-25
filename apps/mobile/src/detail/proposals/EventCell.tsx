// 设备进程注入在用户消息开头的那一段（<litch-session-event>）画成一条轻的提示，不画成用户说的话：
// 子会话的回报（每条一行，还在列表里的子会话点了进去）、子会话都停下了的唤醒、模型没调收尾时的提醒。
// 还排着、没交给模型的回报（SessionSummary.queuedNotes）不进对话区：输入框上方、后台任务那一行旁边一个小按钮，
// 几条都合成一个（一条写来自谁，多条写几条），点开在输入框上方展开整份（QueuedNotesChip、QueuedNotesPanel，
// 照 Claude 桌面端收成一行、点开再看）；交出去之后小按钮没了，回报画在带着它的那条消息上。
import { keys, type SessionNoteView, type SessionSummary } from '@litch/core'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { memo } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { RootStackParamList } from '../../nav/routes'
import { useKey } from '../../shell/services'
import { type Key, useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import type { Props } from '../cells'
import { useTranscript } from '../context'

const HEAD = {
  notes: 'tree.event.notes',
  wake: 'tree.event.wake',
  remind: 'proposals.remind',
} as const

function Note({
  deviceId,
  note,
  openSession,
}: {
  deviceId: string
  note: SessionNoteView
  openSession(sessionId: string): void
}) {
  const { c, font } = useTheme()
  const t = useT()
  const listed = useKey<SessionSummary>(keys.summary(deviceId, note.threadId))
  const head = `${note.title || (listed ? t.text(listed.title) : note.threadId)} · ${t(`tree.note.${note.status}`)}`
  const body = [note.excerpt, note.error].filter(Boolean).join(' · ')
  return (
    <Pressable
      disabled={!listed}
      accessibilityRole={listed ? 'button' : undefined}
      accessibilityHint={listed ? t('tree.child.open') : undefined}
      onPress={() => openSession(note.threadId)}
      style={({ pressed }) => [styles.note, pressed ? { backgroundColor: c.press } : null]}
    >
      <Text
        numberOfLines={3}
        style={{ color: c.ink2, fontSize: font.size.small + 1, lineHeight: 18 }}
      >
        <Text style={{ color: listed ? c.accent : c.ink2 }}>{head}</Text>
        {body ? `：${body}` : ''}
      </Text>
    </Pressable>
  )
}

function EventBar({
  testID,
  head,
  notes,
}: {
  testID: string
  head: Key
  notes: SessionNoteView[]
}) {
  const { c, font } = useTheme()
  const t = useT()
  const { deviceId, openSession } = useTranscript()
  return (
    <View testID={testID} style={[styles.bar, { borderLeftColor: c.line2 }]}>
      <Text style={[styles.head, { color: c.ink3, fontFamily: font.mono }]}>ⓘ {t(head)}</Text>
      {notes.map((note) => (
        <Note key={note.threadId} deviceId={deviceId} note={note} openSession={openSession} />
      ))}
    </View>
  )
}

export const EventCell = memo(function EventCell({ row }: Props<'event'>) {
  return <EventBar testID={`session-event:${row.kind}`} head={HEAD[row.kind]} notes={row.notes} />
})

/** 这个会话还排着、没交给模型的子会话回报 */
const useQueuedNotes = (deviceId: string, sessionId: string) =>
  useKey<SessionSummary>(keys.summary(deviceId, sessionId))?.queuedNotes ?? []

/** 输入框上方的小按钮：“收到某某的回报”或“收到 N 条子会话的回报”，点了开关浮窗。没有排着的不画 */
export function QueuedNotesChip({
  deviceId,
  sessionId,
  open,
  onToggle,
}: {
  deviceId: string
  sessionId: string
  open: boolean
  onToggle(): void
}) {
  const t = useT()
  const theme = useTheme()
  const { c, font } = theme
  const notes = useQueuedNotes(deviceId, sessionId)
  if (notes.length === 0) return null
  const only = notes.length === 1 ? notes[0] : undefined
  const label = only
    ? t('tree.queued.one', { title: only.title || only.threadId })
    : t('tree.queued.many', { count: notes.length })
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={label}
      accessibilityHint={t('tree.queued.hint')}
      testID="queued-notes:chip"
      onPress={onToggle}
      style={({ pressed }) => [
        styles.chip,
        {
          borderColor: open ? c.ink2 : c.line2,
          backgroundColor: pressed ? c.press : open ? c.raised : 'transparent',
          borderRadius: theme.radius.m,
        },
      ]}
    >
      <Text style={{ color: c.ink3, fontFamily: font.mono, fontSize: 13 }}>ⓘ</Text>
      <Text numberOfLines={1} style={[styles.chipText, { color: c.ink }]}>
        {label}
      </Text>
      <Text style={{ color: c.ink3 }}>{open ? '▾' : '▴'}</Text>
    </Pressable>
  )
}

/** 浮窗：排着的回报一条一行，点了进那个子会话。都交出去了就不画 */
export function QueuedNotesPanel({
  deviceId,
  sessionId,
  onClose,
}: {
  deviceId: string
  sessionId: string
  onClose(): void
}) {
  const t = useT()
  const theme = useTheme()
  const { c, font } = theme
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const notes = useQueuedNotes(deviceId, sessionId)
  if (notes.length === 0) return null
  const openSession = (id: string) => {
    onClose()
    navigation.push('Detail', { deviceId, sessionId: id })
  }
  return (
    <View
      testID="queued-notes:panel"
      style={[
        styles.panel,
        { borderColor: c.line2, backgroundColor: c.raised, borderRadius: theme.radius.l },
      ]}
    >
      <View style={styles.panelHead}>
        <Text style={[styles.grow, { color: c.ink3, fontSize: font.size.meta }]}>
          {t('tree.queued.hint')}
        </Text>
        <Pressable
          accessibilityRole="button"
          testID="queued-notes:close"
          onPress={onClose}
          hitSlop={8}
          style={({ pressed }) => [styles.close, pressed ? { backgroundColor: c.press } : null]}
        >
          <Text style={{ color: c.accent, fontSize: font.size.meta }}>
            {t('detail.group.collapse')}
          </Text>
        </Pressable>
      </View>
      <ScrollView style={styles.list} contentContainerStyle={styles.listBody}>
        {notes.map((note) => (
          <Note key={note.threadId} deviceId={deviceId} note={note} openSession={openSession} />
        ))}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { marginHorizontal: 16, marginVertical: 4, paddingLeft: 10, borderLeftWidth: 2, gap: 2 },
  head: { fontSize: 12, paddingVertical: 2 },
  note: { paddingVertical: 2 },
  grow: { flex: 1 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 32,
    maxWidth: '100%',
    paddingHorizontal: 10,
    marginBottom: 6,
    borderWidth: 1,
  },
  chipText: { flexShrink: 1, fontSize: 13, fontWeight: '500' },
  panel: { marginHorizontal: 12, marginBottom: 6, borderWidth: 1, paddingVertical: 8 },
  panelHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8 },
  close: { paddingHorizontal: 6, paddingVertical: 2 },
  // 排得多了在浮窗里自己滚，不把对话区挤没
  list: { maxHeight: 240, marginTop: 4 },
  listBody: { paddingHorizontal: 12, gap: 2 },
})
