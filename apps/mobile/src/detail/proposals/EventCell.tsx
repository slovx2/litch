// 设备进程注入在用户消息开头的那一段（<litch-session-event>）画成一条轻的提示，不画成用户说的话：
// 子会话的回报（每条一行，还在列表里的子会话点了进去）、子会话都停下了的唤醒、模型没调收尾时的提醒。
// 还排着、没交给模型的回报（SessionSummary.queuedNotes）同样画一条，放在对话区最下面（QueuedNotesCell），
// 进队列就出现，交出去之后它画在带着它的那条消息上。
import { keys, type SessionNoteView, type SessionSummary } from '@litch/core'
import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
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

function Note({ note }: { note: SessionNoteView }) {
  const { c, font } = useTheme()
  const t = useT()
  const { deviceId, openSession } = useTranscript()
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
  return (
    <View testID={testID} style={[styles.bar, { borderLeftColor: c.line2 }]}>
      <Text style={[styles.head, { color: c.ink3, fontFamily: font.mono }]}>ⓘ {t(head)}</Text>
      {notes.map((note) => (
        <Note key={note.threadId} note={note} />
      ))}
    </View>
  )
}

export const EventCell = memo(function EventCell({ row }: Props<'event'>) {
  return <EventBar testID={`session-event:${row.kind}`} head={HEAD[row.kind]} notes={row.notes} />
})

/** 这个会话还排着、没交给模型的子会话回报：对话区最下面一条。没有的不画 */
export function QueuedNotesCell() {
  const { deviceId, sessionId } = useTranscript()
  const summary = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const notes = summary?.queuedNotes
  if (!notes?.length) return null
  return <EventBar testID="session-event:queued" head="tree.event.queued" notes={notes} />
}

const styles = StyleSheet.create({
  bar: { marginHorizontal: 16, marginVertical: 4, paddingLeft: 10, borderLeftWidth: 2, gap: 2 },
  head: { fontSize: 12, paddingVertical: 2 },
  note: { paddingVertical: 2 },
})
