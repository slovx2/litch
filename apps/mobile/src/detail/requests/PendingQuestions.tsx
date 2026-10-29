// 和桌面共用待答集合；原回合移出屏幕后仍能直接回答。
import { type PendingQuestion, pendingReplyText } from '@litch/core'
import { useState, useSyncExternalStore } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import type { SessionStore } from '../../core/session-store'
import { useServices } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { sendFlags, whenRunning } from '../composer/send-mode'
import { CardButton } from './Card'

/** 和请求卡片（Card.tsx）同一个样子：等待色的边、◆ 标题行，点标题收成一行；题多了在里面滚 */
export function PendingQuestions({ store, maxHeight }: { store: SessionStore; maxHeight: number }) {
  const meta = useSyncExternalStore(store.subscribeMeta, store.getMeta)
  const [expanded, setExpanded] = useState(true)
  const theme = useTheme()
  const { c, font } = theme
  const t = useT()
  const questions = meta?.pendingQuestions ?? []
  if (questions.length === 0) return null
  return (
    <View
      testID="pending-questions"
      style={[
        styles.frame,
        { maxHeight, backgroundColor: c.raised, borderColor: c.wait, borderRadius: theme.radius.l },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={({ pressed }) => [
          styles.head,
          expanded ? { borderBottomColor: c.line1, ...styles.split } : null,
          { opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <Text style={[styles.mark, { color: c.wait }]}>◆</Text>
        <Text style={[styles.count, { color: c.ink2, fontSize: font.size.meta }]}>
          {t('ask.pendingCount', { count: questions.length })}
        </Text>
        <Text style={{ color: c.ink3, fontSize: font.size.meta }}>{expanded ? '▾' : '▸'}</Text>
      </Pressable>
      {expanded ? (
        <ScrollView style={styles.body} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
          {questions.map((question, index) => (
            <PendingCard key={question.id} question={question} store={store} first={index === 0} />
          ))}
        </ScrollView>
      ) : null}
    </View>
  )
}

function PendingCard({
  question,
  store,
  first,
}: {
  question: PendingQuestion
  store: SessionStore
  first: boolean
}) {
  const meta = useSyncExternalStore(store.subscribeMeta, store.getMeta)
  const { channel, prefs } = useServices()
  const theme = useTheme()
  const { c, font, radius } = theme
  const t = useT()
  const [text, setText] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const enabled = meta?.live === true
  const send = async (answer: string) => {
    if (!enabled || busy || !answer.trim()) return
    setBusy(true)
    setFailure(null)
    try {
      await channel.command('session.send', {
        deviceId: store.deviceId,
        sessionId: store.sessionId,
        text: pendingReplyText(question, answer.trim()),
        ...(question.kind === 'async'
          ? { now: true }
          : sendFlags(whenRunning(prefs.sendMode, meta?.can))),
      })
    } catch (error) {
      setFailure(whyNot(error, t))
    } finally {
      setBusy(false)
    }
  }
  // 一道题：题目，建议的回答一排，下面是自己写的一栏和发送
  return (
    <View
      style={[styles.question, first ? null : { borderTopColor: c.line1, ...styles.splitTop }]}
      testID={`pending:${question.id}`}
    >
      <Text style={[styles.title, { color: c.ink, fontSize: font.size.body }]}>
        {question.title}
      </Text>
      {question.options.length > 0 ? (
        <View style={styles.row}>
          {question.options.map((option, index) => (
            <CardButton
              key={option.label}
              label={option.label}
              kind={
                (question.kind === 'wrap' ? index === 0 : picked === option.answer)
                  ? 'primary'
                  : 'plain'
              }
              disabled={!enabled || busy}
              onPress={() =>
                question.kind === 'wrap' ? void send(option.answer) : setPicked(option.answer)
              }
              testID={`pending:${question.id}:${index}`}
            />
          ))}
        </View>
      ) : null}
      <View style={styles.row}>
        <TextInput
          multiline
          submitBehavior="newline"
          accessibilityLabel={t('ask.reply')}
          placeholder={t('ask.other')}
          placeholderTextColor={c.ink3}
          value={text}
          onChangeText={setText}
          editable={enabled && !busy}
          style={[
            styles.input,
            {
              minHeight: theme.hit - 4,
              color: c.ink,
              backgroundColor: c.sunken,
              borderColor: c.line2,
              borderRadius: radius.m,
              fontSize: font.size.body,
            },
          ]}
        />
        <CardButton
          label={t('ask.send')}
          disabled={!enabled || busy || !(text.trim() || picked)}
          onPress={() => void send(text.trim() || picked || '')}
        />
      </View>
      {failure ? <Text style={[styles.err, { color: c.err }]}>{failure}</Text> : null}
    </View>
  )
}
const styles = StyleSheet.create({
  frame: {
    marginHorizontal: 8,
    marginBottom: 6,
    borderWidth: 1,
    borderLeftWidth: 3,
    overflow: 'hidden',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  split: { borderBottomWidth: StyleSheet.hairlineWidth },
  splitTop: { borderTopWidth: StyleSheet.hairlineWidth },
  mark: { fontSize: 12 },
  count: { flex: 1 },
  body: { flexGrow: 0, flexShrink: 1 },
  question: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  title: { fontWeight: '600', lineHeight: 21 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  input: {
    flex: 1,
    minWidth: 120,
    maxHeight: 120,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    textAlignVertical: 'center',
  },
  err: { fontSize: 12 },
})
