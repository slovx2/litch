// 和桌面共用待答集合；原回合移出屏幕后仍能直接回答。
import { type PendingQuestion, pendingReplyText } from '@litch/core'
import { useState, useSyncExternalStore } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import type { SessionStore } from '../../core/session-store'
import { useServices } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'
import { sendFlags, whenRunning } from '../composer/send-mode'

export function PendingQuestions({ store, maxHeight }: { store: SessionStore; maxHeight: number }) {
  const meta = useSyncExternalStore(store.subscribeMeta, store.getMeta)
  const [expanded, setExpanded] = useState(true)
  const { c, font } = useTheme()
  const t = useT()
  const questions = meta?.pendingQuestions ?? []
  if (questions.length === 0) return null
  return (
    <View style={{ maxHeight, backgroundColor: c.panel }} testID="pending-questions">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={styles.heading}
      >
        <Text style={{ color: c.wait, fontSize: font.size.meta }}>
          ● {t('ask.pendingCount', { count: questions.length })} {expanded ? '⌄' : '›'}
        </Text>
      </Pressable>
      {expanded ? (
        <ScrollView keyboardShouldPersistTaps="handled">
          {questions.map((question) => (
            <PendingCard key={question.id} question={question} store={store} />
          ))}
        </ScrollView>
      ) : null}
    </View>
  )
}

function PendingCard({ question, store }: { question: PendingQuestion; store: SessionStore }) {
  const meta = useSyncExternalStore(store.subscribeMeta, store.getMeta)
  const { channel, prefs } = useServices()
  const { c, font, radius } = useTheme()
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
  return (
    <View
      style={[styles.card, { borderColor: c.line2, borderRadius: radius.m }]}
      testID={`pending:${question.id}`}
    >
      <Text style={{ color: c.ink, fontSize: font.size.body }}>{question.title}</Text>
      <View style={styles.actions}>
        {question.options.map((option, index) => (
          <Button
            key={option.label}
            label={option.label}
            kind={
              (question.kind === 'wrap' ? index === 0 : picked === option.answer)
                ? undefined
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
      {picked ? <Text style={{ color: c.ink2 }}>{picked}</Text> : null}
      <View style={styles.actions}>
        <TextInput
          accessibilityLabel={t('ask.reply')}
          placeholder={t('ask.other')}
          placeholderTextColor={c.ink3}
          value={text}
          onChangeText={setText}
          editable={enabled && !busy}
          style={[styles.input, { color: c.ink, borderColor: c.line2, borderRadius: radius.m }]}
        />
        <Button
          label={t('ask.send')}
          disabled={!enabled || busy || !(text.trim() || picked)}
          onPress={() => void send(text.trim() || picked || '')}
        />
      </View>
      {failure ? <Text style={{ color: c.err }}>{failure}</Text> : null}
    </View>
  )
}
const styles = StyleSheet.create({
  heading: { paddingHorizontal: 16, paddingVertical: 8 },
  card: { marginHorizontal: 16, marginBottom: 8, padding: 10, gap: 8, borderWidth: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  input: { flex: 1, minWidth: 80, minHeight: 44, borderWidth: 1, paddingHorizontal: 10 },
})
