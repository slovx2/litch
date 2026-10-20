// 设备进程注入在用户消息开头的那一段（<litch-session-event>）画成一条轻的提示，不画成用户说的话：
// 子会话的回报（每条一行，还在列表里的子会话点了进去）、子会话都停下了的唤醒、模型没调收尾时的提醒。
import { keys, type SessionNoteView, type SessionSummary } from '@litch/core'
import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
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
        {note.excerpt ? `：${note.excerpt}` : ''}
      </Text>
    </Pressable>
  )
}

export const EventCell = memo(function EventCell({ row }: Props<'event'>) {
  const { c, font } = useTheme()
  const t = useT()
  return (
    <View testID={`session-event:${row.kind}`} style={[styles.bar, { borderLeftColor: c.line2 }]}>
      <Text style={[styles.head, { color: c.ink3, fontFamily: font.mono }]}>
        ⓘ {t(HEAD[row.kind])}
      </Text>
      {row.notes.map((note) => (
        <Note key={note.threadId} note={note} />
      ))}
    </View>
  )
})

const styles = StyleSheet.create({
  bar: { marginHorizontal: 16, marginVertical: 4, paddingLeft: 10, borderLeftWidth: 2, gap: 2 },
  head: { fontSize: 12, paddingVertical: 2 },
  note: { paddingVertical: 2 },
})
