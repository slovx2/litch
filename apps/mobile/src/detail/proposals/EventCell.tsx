// 设备进程注入在用户消息开头的那一段（<litch-session-event>）画成一条轻的提示，不画成用户说的话：
// 子会话的回报（每条头一行写标题和状态，还在列表里的子会话点了进去；正文在下面占满整宽、按 Markdown 画）、
// 子会话都停下了的唤醒、模型没调收尾时的提醒。
// 还排着、没交给模型的回报（SessionSummary.queuedNotes）不进对话区：输入框上方、后台任务那一行旁边一个小按钮，
// 几条都合成一个（一条写来自谁，多条写几条），点开在输入框上方展开整份（QueuedNotesChip、QueuedNotesPanel，
// 照 Claude 桌面端收成一行、点开再看）；交出去之后小按钮没了，回报画在带着它的那条消息上。
// 浮窗里的“立即处理”让设备进程当场交出去（在跑就插进去，停着就开一个回合），同桌面端。
import { keys, type SessionNoteView, type SessionSummary } from '@litch/core'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { memo, useMemo, useSyncExternalStore } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import { queuedNotesOperation } from '../../../../../packages/ui/src/tree/queued-notes-operation.ts'
import { ReportText } from '../../../../../packages/ui/src/tree/report-text.ts'
import type { RootStackParamList } from '../../nav/routes'
import { useChannel, useKey } from '../../shell/services'
import { type Key, useT } from '../../ui/i18n'
import { Caret, Icon } from '../../ui/kit/Icon'
import { useTheme } from '../../ui/theme'
import { CardMarkdown } from '../CardMarkdown'
import { CompactRow } from '../CompactRow'
import type { Props } from '../cells'
import { useTranscript } from '../context'
import { useCardOpen } from '../use-card-open'

const HEAD: Partial<Record<string, Key>> = {
  notes: 'tree.event.notes',
  wake: 'tree.event.wake',
  remind: 'proposals.remind',
  'manager-answers': 'manager.event.answers',
  'manager-ignored': 'manager.event.ignored',
  'manager-suggestions': 'manager.event.suggestions',
  'manager-open': 'manager.event.open',
  'manager-end': 'manager.event.end',
  'manager-rules': 'manager.event.rules',
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
  const channel = useChannel()
  const { threadId, turnId, truncated } = note
  const report = useMemo(
    () =>
      new ReportText({ turnId, truncated }, () =>
        channel.command('session.peek', {
          deviceId,
          sessionId: threadId,
          ...(turnId ? { turnId } : {}),
        }),
      ),
    [channel, deviceId, threadId, turnId, truncated],
  )
  const state = useSyncExternalStore(report.subscribe, report.snapshot)
  const listed = useKey<SessionSummary>(keys.summary(deviceId, note.threadId))
  const title = note.title || (listed ? t.text(listed.title) : note.threadId)
  const body = state.open ? state.text : note.excerpt
  return (
    <View style={styles.note}>
      {/* 头一行：标题（能点进子会话）、状态、读全文的小图标；正文在下面，不和标题挤在一段字里 */}
      <View style={styles.noteRow}>
        <Pressable
          disabled={!listed}
          accessibilityRole={listed ? 'button' : undefined}
          accessibilityHint={listed ? t('tree.child.open') : undefined}
          onPress={() => openSession(note.threadId)}
          style={({ pressed }) => [styles.grow, pressed ? { backgroundColor: c.press } : null]}
        >
          <Text
            numberOfLines={1}
            style={{ color: c.ink3, fontSize: font.size.meta, lineHeight: 18 }}
          >
            <Text style={{ color: listed ? c.accent : c.ink, fontWeight: '600' }}>{title}</Text>
            {` · ${t(`tree.note.${note.status}`)}`}
          </Text>
        </Pressable>
        {report.expandable ? (
          <Pressable
            testID={`report-expand:${note.threadId}`}
            accessibilityRole="button"
            accessibilityLabel={t(
              state.busy
                ? 'tree.report.loading'
                : state.open
                  ? 'tree.report.collapse'
                  : 'tree.report.expand',
            )}
            accessibilityState={{ expanded: state.open, disabled: state.busy }}
            disabled={state.busy}
            hitSlop={8}
            onPress={() => void report.toggle()}
            style={styles.reportExpand}
          >
            {state.busy ? (
              <ActivityIndicator size="small" color={c.accent} />
            ) : (
              <Caret open={state.open} color={c.accent} />
            )}
          </Pressable>
        ) : null}
      </View>
      {body ? <CardMarkdown text={body} /> : null}
      {note.error ? (
        <Text style={{ color: c.err, fontSize: font.size.meta }}>{note.error}</Text>
      ) : null}
      {state.missing || state.error ? (
        <Text accessibilityRole="alert" style={{ color: c.err, fontSize: font.size.meta }}>
          {state.missing ? t('tree.report.missing') : whyNot(state.error, t)}
        </Text>
      ) : null}
    </View>
  )
}

function EventBar({
  testID,
  id,
  head,
  notes,
  body,
  summary,
}: {
  testID: string
  id: string
  head: Key
  notes: SessionNoteView[]
  body?: string
  summary?: string
}) {
  const [open, toggle] = useCardOpen(id)
  const t = useT()
  const { deviceId, openSession } = useTranscript()
  return (
    <CompactRow
      testID={testID}
      mark="info"
      source={t(head)}
      summary={
        summary ??
        notes
          .map((n) => [n.title || n.threadId, n.excerpt || n.error].filter(Boolean).join('：'))
          .join(' · ')
      }
      open={open}
      onPress={toggle}
      fixed={notes.length === 0 && !body}
    >
      {/* 经理事件、认不出的事件自带的正文：同回报按 Markdown 画（同桌面） */}
      {body ? <CardMarkdown text={body} /> : null}
      {notes.map((note) => (
        <Note key={note.threadId} deviceId={deviceId} note={note} openSession={openSession} />
      ))}
    </CompactRow>
  )
}

export const EventCell = memo(function EventCell({ row }: Props<'event'>) {
  return (
    <EventBar
      id={row.key}
      testID={`session-event:${row.kind}`}
      head={HEAD[row.kind] ?? 'tree.event.generic'}
      notes={row.notes}
      body={row.body}
      summary={row.summary}
    />
  )
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
  const { c } = theme
  const notes = useQueuedNotes(deviceId, sessionId)
  const channel = useChannel()
  const operation = queuedNotesOperation(channel, deviceId, sessionId)
  const { busy, error, notNow } = useSyncExternalStore(operation.subscribe, operation.snapshot)
  if (!notes.length && !busy && !error && !notNow) return null
  const only = notes.length === 1 ? notes[0] : undefined
  const label = busy
    ? t('tree.queued.processing')
    : error || notNow
      ? t('tree.queued.failed')
      : only
        ? t('tree.queued.one', { title: only.title || only.threadId })
        : t('tree.queued.many', { count: notes.length })
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open, busy }}
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
      {busy ? (
        <ActivityIndicator size="small" color={c.accent} />
      ) : (
        <Icon name="info" size={15} color={error || notNow ? c.err : c.ink3} />
      )}
      <Text numberOfLines={1} style={[styles.chipText, { color: c.ink }]}>
        {label}
      </Text>
      {/* 浮窗开在片的上方：收着朝上，开着朝下 */}
      <Icon name={open ? 'down' : 'up'} size={14} color={c.ink3} />
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
  const channel = useChannel()
  const notes = useQueuedNotes(deviceId, sessionId)
  const operation = queuedNotesOperation(channel, deviceId, sessionId)
  const { busy, error, notNow } = useSyncExternalStore(operation.subscribe, operation.snapshot)
  const failure = error ? whyNot(error, t) : notNow ? t('tree.queued.notNow') : null
  if (!notes.length && !busy && !failure) return null
  const openSession = (id: string) => {
    onClose()
    navigation.push('Detail', { deviceId, sessionId: id })
  }
  const deliver = () => {
    void operation.start()
    onClose()
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
          accessibilityState={{ disabled: busy }}
          testID="queued-notes:deliver"
          disabled={busy}
          onPress={deliver}
          hitSlop={8}
          style={({ pressed }) => [
            styles.deliver,
            { backgroundColor: pressed ? c.press : c.accent, borderRadius: theme.radius.m },
          ]}
        >
          <Text style={{ color: c.onAccent, fontSize: font.size.meta, fontWeight: '600' }}>
            {t(
              busy
                ? 'tree.queued.processing'
                : failure
                  ? 'tree.queued.retry'
                  : 'tree.queued.deliver',
            )}
          </Text>
        </Pressable>
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
      {failure ? (
        <Text
          accessibilityRole="alert"
          style={[styles.failure, { color: c.err, fontSize: font.size.meta }]}
        >
          {failure}
        </Text>
      ) : null}
      {!notes.length && failure ? (
        <Pressable accessibilityRole="button" onPress={operation.dismiss} style={styles.close}>
          <Text style={{ color: c.accent }}>{t('tree.queued.dismiss')}</Text>
        </Pressable>
      ) : null}
      <ScrollView style={styles.list} contentContainerStyle={styles.listBody}>
        {notes.map((note) => (
          <Note key={note.threadId} deviceId={deviceId} note={note} openSession={openSession} />
        ))}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  note: { paddingVertical: 2, gap: 2 },
  noteRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reportExpand: { minWidth: 32, minHeight: 32, alignItems: 'center', justifyContent: 'center' },
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
  deliver: { paddingHorizontal: 10, paddingVertical: 4 },
  failure: { paddingHorizontal: 12, marginTop: 4 },
  // 排得多了在浮窗里自己滚，不把对话区挤没
  list: { maxHeight: 240, marginTop: 4 },
  listBody: { paddingHorizontal: 12, gap: 2 },
})
