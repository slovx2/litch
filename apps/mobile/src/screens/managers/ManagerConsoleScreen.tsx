// 手机复用核心经理契约；正文沿用对话 Markdown，提案沿用正式操作组件。
import {
  type DeviceView,
  keys,
  type ManagerBoardTopicView,
  type ManagerView,
  type SuggestionView,
} from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useContext, useEffect, useRef, useState } from 'react'
import { Alert, Linking, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { EnrichedMarkdownText } from 'react-native-enriched-markdown'
import type { ManagerPost } from '../../../../../packages/protocol/src/manager-posts.mjs'
import { stamp } from '../../../../../packages/ui/src/app/format.ts'
import { markdownStyleOf } from '../../detail/markdownStyle'
import { ProposalActs } from '../../detail/proposals/ProposalActs'
import type { RootStackParamList } from '../../nav/routes'
import { jsonFile } from '../../shell/json-file'
import { useChannel, useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button, Empty } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { IssueContext, IssueRelations } from './IssueRelations'
import { issueLinks } from './relations'

const replyFile = jsonFile<Record<string, string>>('manager-replies.json')
const draftFile = jsonFile<Record<string, string>>('manager-questions.json')
type Props = NativeStackScreenProps<RootStackParamList, 'ManagerConsole'>
function Markdown({ text }: { text: string }) {
  const theme = useTheme()
  const t = useT()
  const context = useContext(IssueContext)
  const ids = new Set([
    ...(context?.board.posts ?? []).map((p) => p.id),
    ...(context?.board.items ?? []).map((i) => i.id),
  ])
  return (
    <EnrichedMarkdownText
      markdown={issueLinks(text, ids)}
      flavor="github"
      markdownStyle={markdownStyleOf(theme)}
      onLinkLongPress={({ url }) => {
        if (!url.startsWith('litch-issue:')) return
        const id = url.slice('litch-issue:'.length)
        const item = context?.board.items.find((i) => i.id === id)
        const post = context?.board.posts?.find((p) => p.id === id)
        const decision = context?.board.decisions.find((d) => d.id === id)
        const request = context?.board.requests?.find((r) => r.id === id)
        const status = item
          ? t(`manager.status.${item.status}`)
          : request
            ? t(`manager.request.${request.status}`)
            : decision
              ? t(
                  decision.status === 'open'
                    ? 'manager.open'
                    : decision.status === 'answered'
                      ? 'manager.answered'
                      : 'manager.closed',
                )
              : post?.kind === 'report'
                ? t(post.unread ? 'manager.reportUnread' : 'manager.reportRead')
                : ''
        Alert.alert(`${id} · ${post?.title ?? item?.title ?? ''}`, status)
      }}
      onLinkPress={({ url }) => {
        if (url.startsWith('litch-issue:')) context?.open(url.slice('litch-issue:'.length))
        else if (/^https?:\/\//.test(url)) void Linking.openURL(url)
      }}
    />
  )
}
function Issue({
  manager,
  post,
  board,
  suggestions,
}: {
  manager: ManagerView
  post: ManagerPost
  board: ManagerBoardTopicView['board']
  suggestions: readonly SuggestionView[]
}) {
  const t = useT()
  const { c, font } = useTheme()
  const channel = useChannel()
  const device = useKey<DeviceView>(keys.device(manager.deviceId))
  const draftKey = JSON.stringify([manager.deviceId, manager.id, post.id])
  const [question, setQuestion] = useState(() => draftFile.read()?.[draftKey] ?? '')
  const [reply, setReply] = useState(() => replyFile.read()?.[draftKey] ?? '')
  const writeReply = (text: string) => {
    try {
      replyFile.write({ ...replyFile.read(), [draftKey]: text })
      setReply(text)
    } catch (e) {
      setError(String(e))
    }
  }
  const [mode, setMode] = useState<'manager' | 'temporary'>('manager')
  const [asking, setAsking] = useState(false)
  const [history, setHistory] = useState(false)
  const [unreviewed, setUnreviewed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const locked = busy || manager.status !== 'active' || device?.connection !== 'online'
  const canTemporary =
    device?.harnesses.find((h) => h.id === manager.harness)?.abilities?.managerQuestions === true
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const request = board?.requests?.find((r) => r.id === post.id)
  const decision = board?.decisions.find((d) => d.id === post.id)
  const suggestion = suggestions.find((s) => s.proposal.id === post.proposalId)
  const pendingReview = suggestion?.managerReview?.state === 'pending'
  const writeQuestion = (text: string) => {
    try {
      const drafts = draftFile.read() ?? {}
      draftFile.write({ ...drafts, [draftKey]: text })
      setQuestion(text)
    } catch (e) {
      setError(String(e))
    }
  }
  const submitReply = (delivered: boolean) =>
    run(async () => {
      if (request) {
        const result = await channel.command('managers.feedback.submit', {
          deviceId: manager.deviceId,
          managerId: manager.id,
          answers: [],
          questions: [],
          requests: [{ requestId: request.id, revision: request.revision, delivered, text: reply }],
        })
        if (result.rejectedRequests[0]) throw new Error(result.rejectedRequests[0].message)
        writeReply('')
      }
    })
  const submitDecision = (optionId: string | null) =>
    run(async () => {
      if (!decision) return
      const result = await channel.command('managers.answers.submit', {
        deviceId: manager.deviceId,
        managerId: manager.id,
        answers: [{ decisionId: decision.id, revision: decision.revision, optionId, text: reply }],
      })
      if (result.rejected[0]) throw new Error(result.rejected[0].message)
      writeReply('')
    })
  return (
    <View
      style={[styles.card, { borderColor: c.line1, backgroundColor: c.panel }]}
      testID={`manager-issue:${post.id}`}
    >
      <Text style={{ color: c.ink, fontSize: font.size.body, fontWeight: '600' }}>
        {post.id} · {post.title}
      </Text>
      {pendingReview ? (
        <Button
          kind="plain"
          label={t('suggestions.unreviewed')}
          onPress={() => setUnreviewed(!unreviewed)}
        />
      ) : null}
      {!pendingReview || unreviewed ? (
        <>
          <IssueRelations id={post.id} />
          <Markdown text={post.body} />
          {post.versions.length ? (
            <>
              <Button
                kind="plain"
                label={t('manager.postHistory')}
                onPress={() => setHistory(!history)}
              />
              {history
                ? post.versions.map((v) => (
                    <View key={`${v.revision}-${v.at}`}>
                      <Text style={{ color: c.ink3 }}>
                        v{v.revision} · {stamp(v.at, Date.now(), t.lang)}
                      </Text>
                      <Markdown text={v.body} />
                    </View>
                  ))
                : null}
            </>
          ) : null}
          {post.kind === 'report' ? (
            <Button
              label={t(post.unread ? 'manager.markRead' : 'manager.reportRead')}
              disabled={locked || !post.unread}
              onPress={() =>
                void run(() =>
                  channel.command('managers.report.read', {
                    deviceId: manager.deviceId,
                    managerId: manager.id,
                    id: post.id as `P-${number}`,
                    revision: post.revision,
                  }),
                )
              }
            />
          ) : null}
          {suggestion ? (
            <ProposalActs
              deviceId={manager.deviceId}
              sessionId={suggestion.source.threadId}
              proposalId={suggestion.proposal.id}
              worktree={suggestion.proposal.worktree ?? false}
            />
          ) : null}
          {request ? (
            <>
              <Text style={{ color: c.ink3 }}>{t(`manager.request.${request.status}`)}</Text>
              {request.response ? <Markdown text={request.response.text} /> : null}
              {request.status !== 'cancelled' ? (
                <>
                  <TextInput
                    accessibilityLabel={t('manager.requestText')}
                    style={[styles.input, { color: c.ink, borderColor: c.line1 }]}
                    multiline
                    value={reply}
                    onChangeText={writeReply}
                  />
                  <Button
                    disabled={locked}
                    label={request.buttonLabel ?? t('manager.requestDone')}
                    onPress={() => void submitReply(true)}
                  />
                  <Button
                    disabled={locked || !reply.trim()}
                    label={t('manager.submit')}
                    onPress={() => void submitReply(false)}
                  />
                </>
              ) : null}
            </>
          ) : null}
          {decision ? (
            <>
              {decision.answer ? <Markdown text={decision.answer.text} /> : null}
              {decision.options.map((o) => (
                <Button
                  key={o.id}
                  kind="plain"
                  label={o.label}
                  disabled={locked}
                  onPress={() => void submitDecision(o.id)}
                />
              ))}
              <TextInput
                accessibilityLabel={t('manager.answer')}
                style={[styles.input, { color: c.ink, borderColor: c.line1 }]}
                multiline
                value={reply}
                onChangeText={writeReply}
              />
              <Button
                disabled={locked || !reply.trim()}
                label={t('manager.submit')}
                onPress={() => void submitDecision(null)}
              />
            </>
          ) : null}
          {post.discussion.messages
            .flatMap((q) => [
              ...(q.question
                ? [{ id: `${q.id}-q`, at: q.at, who: t('manager.questionYou'), text: q.question }]
                : []),
              {
                id: `${q.id}-a`,
                at: q.answeredAt ?? q.at,
                who: t(
                  q.mode === 'manager'
                    ? 'manager.questionManagerSpeaker'
                    : 'manager.questionTemporarySpeaker',
                ),
                text:
                  q.answer ??
                  t(
                    q.updatedPost
                      ? 'manager.postUpdatedReply'
                      : q.status === 'failed'
                        ? 'manager.questionFailed'
                        : 'manager.questionPending',
                  ),
              },
            ])
            .sort((a, b) => a.at - b.at)
            .map((entry) => (
              <View key={entry.id} style={[styles.discussion, { borderColor: c.line1 }]}>
                <Text style={{ color: c.ink3 }}>
                  {entry.who} · {stamp(entry.at, Date.now(), t.lang)}
                </Text>
                <Markdown text={entry.text} />
              </View>
            ))}
          <Button
            kind="plain"
            label={t('manager.postAsk')}
            disabled={locked}
            onPress={() => setAsking(!asking)}
          />
          {asking ? (
            <>
              <View style={styles.actions}>
                <Button
                  kind={mode === 'manager' ? 'solid' : 'plain'}
                  label={t('manager.questionManager')}
                  onPress={() => setMode('manager')}
                />
                {canTemporary ? (
                  <Button
                    kind={mode === 'temporary' ? 'solid' : 'plain'}
                    label={t('manager.questionTemporary')}
                    onPress={() => setMode('temporary')}
                  />
                ) : null}
              </View>
              <Text style={{ color: c.ink3 }}>
                {t(mode === 'manager' ? 'manager.questionManager' : 'manager.questionTemporary')}
              </Text>
              <TextInput
                multiline
                accessibilityLabel={t('manager.questionInput')}
                style={[styles.input, { color: c.ink, borderColor: c.line1 }]}
                value={question}
                onChangeText={writeQuestion}
              />
              <Button
                label={t('manager.postSubmit')}
                disabled={locked || !question.trim()}
                onPress={() =>
                  void run(async () => {
                    await channel.command('managers.post.question', {
                      deviceId: manager.deviceId,
                      managerId: manager.id,
                      id: post.id,
                      revision: post.revision,
                      question,
                      mode,
                    })
                    writeQuestion('')
                  })
                }
              />
            </>
          ) : null}
        </>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: c.err }}>
          {error}
        </Text>
      ) : null}
    </View>
  )
}
export function ManagerConsoleScreen({ route }: Props) {
  const { deviceId, managerId } = route.params
  const replica = useReplica()
  const t = useT()
  const { c } = useTheme()
  const [kind, setKind] = useState<ManagerPost['kind'] | 'item'>('decision')
  useEffect(() => replica.openManagerBoard(deviceId, managerId), [replica, deviceId, managerId])
  const manager = useKey<ManagerView>(keys.manager(deviceId, managerId))
  const device = useKey<DeviceView>(keys.device(deviceId))
  const view = useKey<ManagerBoardTopicView>(keys.managerBoard(deviceId, managerId))
  const suggestions = useKey<readonly SuggestionView[]>(keys.suggestions) ?? []
  const scroll = useRef<ScrollView>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const openIssue = (id: string) => {
    setSelected(id)
    scroll.current?.scrollTo({ y: 0, animated: true })
    setKind(
      id.startsWith('I-')
        ? 'item'
        : (view?.board?.posts?.find((p) => p.id === id)?.kind ?? 'decision'),
    )
  }
  const kinds = {
    decision: 'manager.decisions',
    suggestion: 'manager.suggestions',
    request: 'manager.requests',
    report: 'manager.reports',
    item: 'manager.items',
  } as const
  return (
    <Screen title={t('manager.inbox')} subtitle={manager?.name} testID="manager-console">
      <View style={styles.actions}>
        {(Object.keys(kinds) as (keyof typeof kinds)[]).map((k) => (
          <Button
            key={k}
            kind={kind === k ? 'solid' : 'plain'}
            label={t(kinds[k])}
            onPress={() => {
              setSelected(null)
              setKind(k)
            }}
          />
        ))}
      </View>
      {device?.connection !== 'online' || manager?.status !== 'active' ? (
        <Text style={{ color: c.ink3, padding: 12 }}>
          {t(
            device?.connection !== 'online'
              ? 'manager.offline'
              : manager?.status === 'ending'
                ? 'manager.ending'
                : 'manager.ended',
          )}
        </Text>
      ) : null}
      <ScrollView ref={scroll}>
        {manager && view?.board ? (
          <IssueContext.Provider value={{ manager, board: view.board, open: openIssue }}>
            {kind === 'item'
              ? view.board.items
                  .filter((i) => !selected || i.id === selected)
                  .map((item) => (
                    <View
                      key={item.id}
                      style={[styles.card, { borderColor: selected === item.id ? c.ink : c.line1 }]}
                    >
                      <Text style={{ color: c.ink }}>
                        {item.id} · {item.title}
                      </Text>
                      <IssueRelations id={item.id} kind="item" />
                      <Markdown text={item.why} />
                    </View>
                  ))
              : null}
            {(view.board.posts ?? [])
              .filter((p) => p.kind === kind && (!selected || p.id === selected))
              .map((post) => (
                <Issue
                  key={post.id}
                  manager={manager}
                  post={post}
                  board={view.board}
                  suggestions={suggestions}
                />
              ))}
            {!(kind === 'item'
              ? view.board.items.length
              : (view.board.posts ?? []).some((p) => p.kind === kind)) ? (
              <Text style={{ color: c.ink3, padding: 16 }}>{t('manager.none')}</Text>
            ) : null}
          </IssueContext.Provider>
        ) : (
          <Empty title={t('manager.loading')} />
        )}
      </ScrollView>
    </Screen>
  )
}
const styles = StyleSheet.create({
  card: { padding: 16, margin: 12, borderWidth: 1, gap: 12 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 8 },
  input: { borderWidth: 1, minHeight: 80, padding: 10, textAlignVertical: 'top' },
  discussion: { borderLeftWidth: 2, paddingLeft: 12, gap: 8 },
})
