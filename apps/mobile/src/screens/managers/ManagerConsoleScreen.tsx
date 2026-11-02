// 手机经理页：概览、控制台、经理事项（只读）三格；复用核心经理契约，正文沿用对话 Markdown，提案沿用正式操作组件。
import {
  type DeviceView,
  decisionDraftState,
  keys,
  MANAGER_ISSUE_ORDERS,
  type ManagerBoardTopicView,
  type ManagerView,
  managerAttentionCount,
  postDraftState,
  requestDraftState,
  type SuggestionView,
} from '@litch/core'
import { useIsFocused } from '@react-navigation/native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useContext, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import type { ManagerDecisionOption } from '../../../../../packages/protocol/src/manager.mjs'
import type { ManagerPost } from '../../../../../packages/protocol/src/manager-posts.mjs'
import { stamp } from '../../../../../packages/ui/src/app/format.ts'
import { readWhileOpen } from '../../../../../packages/ui/src/app/read.ts'
import { ProposalActs } from '../../detail/proposals/ProposalActs'
import type { RootStackParamList } from '../../nav/routes'
import { jsonFile } from '../../shell/json-file'
import { useChannel, useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button, Empty } from '../../ui/kit/controls'
import { Sheet } from '../../ui/kit/overlays'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { readChoice, writeChoice } from './choice-drafts'
import { DecisionAnswer, DecisionHistory, DecisionOutcome } from './DecisionOutcome'
import { DraftEndedNote } from './DraftEndedNote'
import { Markdown } from './IssueMarkdown'
import { IssueContext, IssueRelations } from './IssueRelations'
import { setIssueOrder, useIssueOrder } from './issue-order'
import { ManagerOverview } from './ManagerOverview'
import { decisionActions, issueCounts, orderedIssues } from './presentation'

const replyFile = jsonFile<Record<string, string>>('manager-replies.json')
const draftFile = jsonFile<Record<string, string>>('manager-questions.json')
/** 草稿开始写时议题的版本（同一个键）：议题在别处答复、关闭、忽略或取消后据此判断草稿已结束（core 的 *DraftState） */
const baseFile = jsonFile<Record<string, number>>('manager-draft-revisions.json')
type Props = NativeStackScreenProps<RootStackParamList, 'ManagerConsole'>

/** 作答的一个选项：整块可点，选中画单选记号和强调边框；读屏角色是 radio */
function OptionChoice({
  decisionId,
  option,
  recommend,
  selected,
  disabled,
  onSelect,
}: {
  decisionId: string
  option: ManagerDecisionOption
  recommend: boolean
  selected: boolean
  disabled: boolean
  onSelect(): void
}) {
  const t = useT()
  const { c, radius, radio, hit } = useTheme()
  return (
    <Pressable
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled}
      aria-label={recommend ? `${option.label} · ${t('manager.recommend')}` : option.label}
      disabled={disabled}
      testID={`decision-choice:${decisionId}:${option.id}`}
      onPress={onSelect}
      style={({ pressed }) => [
        styles.choice,
        {
          minHeight: hit,
          borderColor: selected ? c.accent : c.line1,
          borderWidth: selected ? 2 : 1,
          borderRadius: radius.s,
          backgroundColor: pressed ? c.press : selected ? c.sunken : 'transparent',
        },
      ]}
    >
      <Text style={{ color: selected ? c.accent : c.ink3 }}>{selected ? radio.on : radio.off}</Text>
      <View style={styles.choiceText}>
        <Text style={{ color: c.ink, fontWeight: '600' }}>
          {option.label}
          {recommend ? <Text style={{ color: c.accent }}> · {t('manager.recommend')}</Text> : null}
        </Text>
        {option.description ? <Markdown text={option.description} /> : null}
      </View>
    </Pressable>
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
  const { c, font, radius, hit } = useTheme()
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
  const setChoice = (optionId: string | null) => {
    try {
      writeChoice(draftKey, optionId)
    } catch (e) {
      setError(String(e))
    }
    setChoiceState(optionId)
  }
  const [mode, setMode] = useState<'manager' | 'temporary'>('manager')
  const [asking, setAsking] = useState(false)
  const [history, setHistory] = useState(false)
  const options = board?.decisions.find((d) => d.id === post.id)?.options ?? []
  /** 作答时选中的选项：先选，再点“提交给经理”（与桌面的单选一致）；和补充文字一样存成草稿 */
  const [choice, setChoiceState] = useState(() => readChoice(draftKey, options))
  // 已答或已关闭的决策留着改了一半的草稿：回来时直接回到修改状态
  const [editing, setEditing] = useState(() => {
    const found = board?.decisions.find((d) => d.id === post.id)
    return Boolean(
      board &&
        found &&
        found.status !== 'open' &&
        (readChoice(draftKey, found.options) || replyFile.read()?.[draftKey]?.trim()) &&
        decisionDraftState(board, found.id, baseFile.read()?.[draftKey] ?? found.revision).state !==
          'ended',
    )
  })
  const [unreviewed, setUnreviewed] = useState(false)
  /** 忽略的决策默认收起，点开看理由、撤销忽略 */
  const [shown, setShown] = useState(false)
  /** 正在填忽略理由；null 是没在填 */
  const [ignoring, setIgnoring] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const locked = busy || manager.status !== 'active' || device?.connection !== 'online'
  // 比应用旧的设备服务没宣告的能力：入口禁用，旁边写明原因（看板顶上另有一行说去设备详情升级）
  const features = useContext(IssueContext)?.features ?? {
    feedback: true,
    posts: true,
    ignore: true,
  }
  const oldReason = (what: keyof typeof features) =>
    features[what] ? null : (
      <Text testID={`old-device-reason:${what}:${post.id}`} style={{ color: c.ink2 }}>
        {t('manager.oldDeviceShort')}
      </Text>
    )
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
  const decisionButtons = decision ? decisionActions(decision) : null
  // 草稿开始写时记下议题版本，清空时删掉；之后议题在别处结束，草稿就不再算、不能提交（与桌面同一规则）
  const revision = decision?.revision ?? request?.revision ?? post.revision
  const hasDraft = Boolean(choice || reply.trim() || question.trim())
  useEffect(() => {
    const bases = baseFile.read() ?? {}
    if (hasDraft && bases[draftKey] === undefined)
      baseFile.write({ ...bases, [draftKey]: revision })
    else if (!hasDraft && bases[draftKey] !== undefined) {
      const { [draftKey]: _cleared, ...rest } = bases
      baseFile.write(rest)
    }
  }, [hasDraft, draftKey, revision])
  const base = baseFile.read()?.[draftKey] ?? revision
  const answerState = !board
    ? null
    : decision
      ? decisionDraftState(board, decision.id, base).state
      : request
        ? requestDraftState(board, request.id, base).state
        : null
  const replyEnded = answerState === 'ended' && Boolean(choice || reply.trim())
  const questionEnded = Boolean(
    board && question.trim() && postDraftState(board, post.id, base).state === 'ended',
  )
  const chosenLabel = decision?.options.find((o) => o.id === choice)?.label
  const endedNote =
    replyEnded || questionEnded ? (
      <DraftEndedNote
        id={post.id}
        text={t(
          decision
            ? decision.status === 'answered'
              ? 'manager.draftEnded.answered'
              : decision.status === 'ignored'
                ? 'manager.draftEnded.ignored'
                : 'manager.draftEnded.closed'
            : request && replyEnded
              ? request.status === 'cancelled'
                ? 'manager.draftEnded.cancelled'
                : 'manager.draftEnded.handled'
              : 'manager.draftEnded.post',
        )}
        onDiscard={() => {
          if (replyEnded) {
            writeReply('')
            setChoice(null)
          }
          if (questionEnded) writeQuestion('')
          setEditing(false)
        }}
      >
        {replyEnded && chosenLabel ? (
          <Text style={{ color: c.ink, fontWeight: '600' }}>{chosenLabel}</Text>
        ) : null}
        {replyEnded && reply.trim() ? <Markdown text={reply} /> : null}
        {questionEnded ? (
          <Text style={{ color: c.ink2 }}>
            {t('manager.questionYou')} {question}
          </Text>
        ) : null}
      </DraftEndedNote>
    ) : null
  const questionPrompt = t(
    mode === 'manager'
      ? 'manager.questionManagerPlaceholder'
      : 'manager.questionTemporaryPlaceholder',
  )
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
        setEditing(false)
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
      setChoice(null)
      setEditing(false)
    })
  // 选了选项或写了补充说明、还没提交：卡片标“草稿”（与桌面一致），免得以为已经答复
  const drafted = Boolean(
    decision && (decision.status === 'open' || editing) && (choice || reply.trim()) && !replyEnded,
  )
  const stateLabel = decision
    ? t(
        drafted
          ? 'manager.draft'
          : decision.status === 'open'
            ? 'manager.open'
            : decision.status === 'answered'
              ? 'manager.answered'
              : decision.status === 'ignored'
                ? 'manager.ignored'
                : 'manager.closed',
      )
    : request
      ? t(`manager.request.${request.status}`)
      : post.kind === 'report'
        ? t(post.unread ? 'manager.reportUnread' : 'manager.reportRead')
        : ''
  const pending =
    drafted || decision?.status === 'open' || request?.status === 'open' || post.unread
  return (
    <View
      style={[styles.card, { borderColor: c.line1, backgroundColor: c.panel }]}
      testID={`manager-issue:${post.id}`}
    >
      <View style={styles.cardHeader}>
        <Text style={{ color: c.ink, fontSize: font.size.title, fontWeight: '600', flex: 1 }}>
          {post.kind === 'suggestion' ? t('manager.suggestions') : post.id} · {post.title}
        </Text>
        {stateLabel ? (
          <Text
            testID={`issue-status:${post.id}`}
            style={[
              styles.status,
              {
                color: pending ? c.wait : c.ink3,
                borderColor: pending ? c.wait : c.line1,
                borderRadius: radius.s,
              },
            ]}
          >
            {stateLabel}
          </Text>
        ) : null}
      </View>
      {pendingReview ? (
        <Button
          kind="plain"
          label={t('suggestions.unreviewed')}
          onPress={() => setUnreviewed(!unreviewed)}
        />
      ) : null}
      {decision?.status === 'ignored' ? (
        <Pressable
          accessibilityRole="button"
          aria-expanded={shown}
          testID={`decision-ignored-toggle:${decision.id}`}
          onPress={() => setShown(!shown)}
          style={[styles.detailsRow, { minHeight: hit }]}
        >
          <Text style={{ color: c.ink2 }}>
            {shown ? '▾' : '▸'} {t(shown ? 'mgr.ignored.hide' : 'mgr.ignored.show')}
          </Text>
        </Pressable>
      ) : null}
      {(!pendingReview || unreviewed) && (decision?.status !== 'ignored' || shown) ? (
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
          {post.kind === 'report' && post.unread ? (
            <Button
              label={t(post.unread ? 'manager.markRead' : 'manager.reportRead')}
              testID={`report-read:${post.id}`}
              disabled={locked || !post.unread || !features.posts}
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
          {post.kind === 'report' && post.unread ? oldReason('posts') : null}
          {suggestion ? (
            <ProposalActs
              deviceId={manager.deviceId}
              sessionId={suggestion.source.threadId}
              proposalId={suggestion.proposal.id}
              worktree={suggestion.proposal.worktree ?? false}
            />
          ) : null}
          {decision || request ? null : endedNote}
          {request ? (
            <>
              {request.response ? <Markdown text={request.response.text} /> : null}
              {/* 先是你的回复，再说留着的草稿怎么办 */}
              {endedNote}
              {request.status !== 'cancelled' &&
              !replyEnded &&
              (request.status === 'open' || editing) ? (
                <>
                  <TextInput
                    accessibilityLabel={t('manager.requestText')}
                    style={[styles.input, { color: c.ink, borderColor: c.line1 }]}
                    multiline
                    editable={features.feedback}
                    value={reply}
                    onChangeText={writeReply}
                  />
                  <Button
                    testID={`request-deliver:${request.id}`}
                    disabled={locked || !features.feedback}
                    label={request.buttonLabel ?? t('manager.requestDone')}
                    onPress={() => void submitReply(true)}
                  />
                  {reply.trim() ? (
                    <Button
                      kind="plain"
                      disabled={locked || !features.feedback}
                      label={t('manager.submit')}
                      onPress={() => void submitReply(false)}
                    />
                  ) : null}
                  {oldReason('feedback')}
                  {request.status !== 'open' ? (
                    <Button
                      kind="plain"
                      label={t('manager.cancelEdit')}
                      onPress={() => {
                        writeReply('')
                        setEditing(false)
                      }}
                    />
                  ) : null}
                </>
              ) : request.status !== 'cancelled' && !replyEnded ? (
                <Button
                  kind="plain"
                  disabled={locked || !features.feedback}
                  label={t('manager.requestEdit')}
                  onPress={() => {
                    writeReply(request.response?.text ?? '')
                    setEditing(true)
                  }}
                />
              ) : null}
            </>
          ) : null}
          {decision ? (
            <>
              {decision.status === 'open' || (editing && !replyEnded) ? (
                <>
                  {/* 修改答案时照样显示原来的答复，选项上也预先选中原来那一项 */}
                  <DecisionAnswer decision={decision} />
                  <DecisionHistory decision={decision} />
                  {/* 确认忽略时收起作答区：一张卡上只留“确认忽略”一个主按钮 */}
                  {ignoring === null ? (
                    <>
                      <View role="radiogroup" aria-label={decision.title} style={styles.options}>
                        {decision.options.map((o) => (
                          <OptionChoice
                            key={o.id}
                            decisionId={decision.id}
                            option={o}
                            recommend={decision.recommend === o.id}
                            selected={choice === o.id}
                            disabled={locked}
                            onSelect={() => setChoice(choice === o.id ? null : o.id)}
                          />
                        ))}
                      </View>
                      <TextInput
                        accessibilityLabel={t('manager.answer')}
                        placeholder={t('manager.answer')}
                        placeholderTextColor={c.ink3}
                        style={[styles.input, { color: c.ink, borderColor: c.line1 }]}
                        multiline
                        value={reply}
                        onChangeText={writeReply}
                      />
                      <View style={styles.actions}>
                        <Button
                          testID={`decision-submit:${decision.id}`}
                          disabled={locked || (!choice && !reply.trim())}
                          label={t('manager.submit')}
                          onPress={() => void submitDecision(choice)}
                        />
                        {decision.recommend && choice !== decision.recommend ? (
                          <Button
                            kind="plain"
                            disabled={locked}
                            label={t('manager.useRecommend')}
                            onPress={() => setChoice(decision.recommend)}
                          />
                        ) : null}
                        {choice ? (
                          <Button
                            kind="plain"
                            disabled={locked}
                            label={t('manager.clearOption')}
                            onPress={() => setChoice(null)}
                          />
                        ) : null}
                        {decisionButtons?.ignore ? (
                          <Button
                            kind="plain"
                            testID={`decision-ignore:${decision.id}`}
                            disabled={locked || !features.ignore}
                            label={t('manager.ignore')}
                            onPress={() => setIgnoring('')}
                          />
                        ) : null}
                      </View>
                      {decisionButtons?.ignore ? oldReason('ignore') : null}
                    </>
                  ) : null}
                  {decisionButtons?.ignore && ignoring !== null ? (
                    <View
                      testID={`decision-ignore-form:${decision.id}`}
                      style={[
                        styles.askComposer,
                        { borderColor: c.line3, backgroundColor: c.sunken },
                      ]}
                    >
                      <Text style={{ color: c.ink2 }}>{t('manager.ignoreNote')}</Text>
                      <TextInput
                        testID={`decision-ignore-reason:${decision.id}`}
                        accessibilityLabel={t('manager.ignoreReason')}
                        placeholder={t('manager.ignoreReason')}
                        placeholderTextColor={c.ink3}
                        style={[styles.input, { color: c.ink, borderColor: c.line1 }]}
                        value={ignoring}
                        onChangeText={setIgnoring}
                      />
                      <View style={styles.actions}>
                        <Button
                          testID={`decision-ignore-confirm:${decision.id}`}
                          disabled={locked}
                          label={t('manager.ignoreConfirm')}
                          onPress={() =>
                            void run(async () => {
                              await channel.command('managers.decision.ignore', {
                                deviceId: manager.deviceId,
                                managerId: manager.id,
                                decisionId: decision.id,
                                revision: decision.revision,
                                ...(ignoring.trim() ? { reason: ignoring.trim() } : {}),
                              })
                              setIgnoring(null)
                              setShown(false)
                            })
                          }
                        />
                        <Button
                          kind="plain"
                          disabled={busy}
                          label={t('manager.cancel')}
                          onPress={() => setIgnoring(null)}
                        />
                      </View>
                    </View>
                  ) : null}
                  {/* 按钮一直显示；不能点时写明为什么（离线、已结束由页顶那一行说） */}
                  {!locked && ignoring === null && !choice && !reply.trim() ? (
                    <Text testID={`decision-submit-why:${decision.id}`} style={{ color: c.ink2 }}>
                      {t(decision.options.length ? 'mgr.answer.empty' : 'mgr.answer.note')}
                    </Text>
                  ) : null}
                  {editing ? (
                    <Button
                      kind="plain"
                      label={t('manager.cancelEdit')}
                      onPress={() => {
                        writeReply('')
                        setChoice(null)
                        setEditing(false)
                      }}
                    />
                  ) : null}
                </>
              ) : (
                <>
                  <DecisionOutcome decision={decision} />
                  {/* 先是答复、关闭或忽略的记录，再说留着的草稿怎么办 */}
                  {endedNote}
                  {decisionButtons?.edit ? (
                    <Button
                      kind="plain"
                      disabled={locked}
                      label={t('manager.editAnswer')}
                      onPress={() => {
                        // 对着当前这一版改：留着的旧草稿版本不算数
                        baseFile.write({ ...baseFile.read(), [draftKey]: decision.revision })
                        writeReply(decision.answer?.text ?? '')
                        setChoice(decision.answer?.optionId ?? null)
                        setEditing(true)
                      }}
                    />
                  ) : null}
                  {decisionButtons?.reopen || decisionButtons?.unignore ? (
                    <Button
                      kind="plain"
                      testID={`decision-${decisionButtons.unignore ? 'unignore' : 'reopen'}:${decision.id}`}
                      disabled={locked}
                      label={t(decisionButtons.unignore ? 'manager.unignore' : 'manager.reopen')}
                      onPress={() =>
                        void run(async () => {
                          await channel.command('managers.decision.reopen', {
                            deviceId: manager.deviceId,
                            managerId: manager.id,
                            decisionId: decision.id,
                          })
                          setEditing(false)
                        })
                      }
                    />
                  ) : null}
                </>
              )}
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
          <Pressable
            accessibilityRole="button"
            accessibilityState={{
              expanded: asking && features.posts,
              disabled: locked || !features.posts,
            }}
            disabled={locked || !features.posts}
            testID={`post-ask:${post.id}`}
            onPress={() => setAsking(!asking)}
            style={styles.textLink}
          >
            <Text style={{ color: c.ink2 }}>
              {asking ? '▾' : '▸'} {t(asking ? 'manager.postAskClose' : 'manager.postAsk')}
            </Text>
          </Pressable>
          {oldReason('posts')}
          {asking && features.posts ? (
            <View style={[styles.askComposer, { borderColor: c.line3, backgroundColor: c.sunken }]}>
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
              <Text style={{ color: c.ink3 }}>{t('manager.postAsk')}</Text>
              <TextInput
                multiline
                accessibilityLabel={questionPrompt}
                placeholder={questionPrompt}
                placeholderTextColor={c.ink3}
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
                    setAsking(false)
                  })
                }
              />
            </View>
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
type Category = ManagerPost['kind']
export function ManagerConsoleScreen({ route, navigation }: Props) {
  const { deviceId, managerId } = route.params
  const replica = useReplica()
  const t = useT()
  const { c, radius, font, hit } = useTheme()
  const [tab, setTab] = useState<'overview' | 'console' | 'items'>(route.params.tab ?? 'overview')
  const [kind, setKind] = useState<Category>('decision')
  const [ordering, setOrdering] = useState(false)
  const order = useIssueOrder()
  useEffect(() => replica.openManagerBoard(deviceId, managerId), [replica, deviceId, managerId])
  const manager = useKey<ManagerView>(keys.manager(deviceId, managerId))
  const focused = useIsFocused()
  const channel = useChannel()
  useEffect(() => {
    if (focused && manager?.threadId)
      return readWhileOpen(channel, replica.store, deviceId, manager.threadId)
  }, [focused, channel, replica, deviceId, manager?.threadId])
  const device = useKey<DeviceView>(keys.device(deviceId))
  const view = useKey<ManagerBoardTopicView>(keys.managerBoard(deviceId, managerId))
  const suggestions = useKey<readonly SuggestionView[]>(keys.suggestions) ?? []
  const scroll = useRef<ScrollView>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const openIssue = (id: string) => {
    setSelected(id)
    scroll.current?.scrollTo({ y: 0, animated: true })
    if (id.startsWith('I-')) setTab('items')
    else {
      setTab('console')
      setKind(
        id.startsWith('R-')
          ? 'request'
          : (view?.board?.posts?.find((p) => p.id === id)?.kind ?? 'decision'),
      )
    }
  }
  const go = (next: typeof tab, category?: Category) => {
    setSelected(null)
    setTab(next)
    if (category) setKind(category)
    scroll.current?.scrollTo({ y: 0, animated: false })
  }
  const openSession = (sessionId: string, title?: string) =>
    navigation.navigate('Detail', { deviceId, sessionId, ...(title ? { title } : {}) })
  const kinds = {
    decision: 'manager.decisions',
    suggestion: 'manager.suggestions',
    request: 'manager.requests',
    report: 'manager.reports',
  } as const
  const counts = issueCounts(manager)
  const features = view?.features ?? { feedback: true, posts: true, ignore: true }
  const missing = (['feedback', 'posts', 'ignore'] as const).filter((key) => !features[key])
  const tabs = {
    overview: 'manager.overview',
    items: 'manager.items',
    console: 'manager.inbox',
  } as const
  return (
    <Screen
      title={t(tabs[tab])}
      subtitle={manager?.name}
      testID="manager-console"
      actions={
        manager
          ? [
              {
                label: t('manager.chat'),
                testID: 'manager:chat',
                onPress: () => openSession(manager.threadId, manager.name || undefined),
              },
            ]
          : []
      }
    >
      {/* 页签是下划线式（与桌面同序：概览、经理事项、控制台），类别是小胶囊，排序跟在类别同一行的末尾 */}
      <View role="tablist" style={[styles.tabs, { borderColor: c.line1 }]}>
        {(Object.keys(tabs) as (keyof typeof tabs)[]).map((key) => {
          const count = key === 'console' && manager ? managerAttentionCount(manager) : 0
          const on = tab === key
          return (
            <Pressable
              key={key}
              role="tab"
              aria-selected={on}
              aria-label={
                count ? `${t(tabs[key])} ${t('manager.pending', { n: count })}` : undefined
              }
              testID={`manager-tab:${key}`}
              onPress={() => go(key)}
              style={[
                styles.tab,
                { minHeight: hit, borderBottomColor: on ? c.accent : 'transparent' },
              ]}
            >
              <Text style={{ color: on ? c.ink : c.ink2, fontWeight: on ? '600' : '400' }}>
                {t(tabs[key])}
              </Text>
              {count ? (
                <Text
                  style={[
                    styles.count,
                    { color: c.wait, borderColor: c.wait, borderRadius: radius.s },
                  ]}
                >
                  {count}
                </Text>
              ) : null}
            </Pressable>
          )
        })}
      </View>
      {tab === 'console' ? (
        <View style={styles.categories}>
          {(Object.keys(kinds) as (keyof typeof kinds)[]).map((k) => {
            const on = kind === k
            const label = t(k === 'report' && counts[k] > 0 ? 'manager.reportUnread' : kinds[k])
            return (
              <Pressable
                key={k}
                role="radio"
                aria-checked={on}
                aria-label={counts[k] > 0 ? `${label} ${counts[k]}` : t(kinds[k])}
                testID={`manager-category:${k}`}
                hitSlop={{ top: 9, bottom: 9 }}
                onPress={() => go('console', k)}
                style={[
                  styles.pill,
                  {
                    borderRadius: radius.l,
                    borderColor: on ? c.accent : c.line2,
                    backgroundColor: on ? c.sunken : 'transparent',
                  },
                ]}
              >
                <Text style={{ color: on ? c.ink : c.ink2, fontSize: font.size.meta + 1 }}>
                  {t(kinds[k])}
                </Text>
                {counts[k] > 0 ? (
                  <Text
                    testID={
                      k === 'report' ? 'manager-reports-unread' : `manager-category-count:${k}`
                    }
                    style={{ color: c.wait, fontSize: font.size.meta + 1, fontWeight: '600' }}
                  >
                    {counts[k]}
                  </Text>
                ) : null}
              </Pressable>
            )
          })}
          <Pressable
            accessibilityRole="button"
            aria-label={`${t('manager.order')}: ${t(`manager.order.${order}`)}`}
            testID="manager-issue-order"
            onPress={() => setOrdering(true)}
            style={[styles.order, { minHeight: hit }]}
          >
            <Text style={{ color: c.ink2, fontSize: font.size.meta + 1 }}>
              {t(`manager.order.${order}`)} ▾
            </Text>
          </Pressable>
        </View>
      ) : null}
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
      ) : missing.length ? (
        <Text testID="manager-old-device" role="note" style={{ color: c.ink2, padding: 12 }}>
          {t('manager.oldDevice', {
            items: missing
              .map((key) => t(`manager.feature.${key}`))
              .join(t('manager.feature.join')),
          })}
        </Text>
      ) : null}
      <ScrollView ref={scroll}>
        {manager && view?.board ? (
          <IssueContext.Provider value={{ manager, board: view.board, features, open: openIssue }}>
            {tab === 'overview' ? (
              <ManagerOverview
                board={view.board}
                onDecisions={() => go('console', 'decision')}
                onItems={() => go('items')}
                onIssue={openIssue}
                onLine={openSession}
              />
            ) : null}
            {tab === 'items'
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
            {tab === 'console'
              ? orderedIssues(
                  (view.board.posts ?? []).filter(
                    (p) => p.kind === kind && (!selected || p.id === selected),
                  ),
                  view.board,
                  order,
                  suggestions,
                ).map((post) => (
                  <Issue
                    key={post.id}
                    manager={manager}
                    post={post}
                    board={view.board}
                    suggestions={suggestions}
                  />
                ))
              : null}
            {tab !== 'overview' &&
            !(tab === 'items'
              ? view.board.items.length
              : (view.board.posts ?? []).some((p) => p.kind === kind)) ? (
              <Text style={{ color: c.ink3, padding: 16 }}>{t('manager.none')}</Text>
            ) : null}
          </IssueContext.Provider>
        ) : (
          <Empty title={t('manager.loading')} />
        )}
      </ScrollView>
      <Sheet
        visible={ordering}
        title={t('manager.order')}
        onClose={() => setOrdering(false)}
        actions={MANAGER_ISSUE_ORDERS.map((key) => ({
          label: t(`manager.order.${key}`),
          testID: `manager-issue-order:${key}`,
          selected: order === key,
          onPress: () => setIssueOrder(key),
        }))}
      />
    </Screen>
  )
}
const styles = StyleSheet.create({
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  status: { borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2 },
  textLink: { alignSelf: 'flex-start', paddingVertical: 8 },
  detailsRow: { alignSelf: 'stretch', justifyContent: 'center' },
  askComposer: { gap: 10, borderLeftWidth: 2, padding: 12 },
  tabs: { flexDirection: 'row', borderBottomWidth: 1, paddingHorizontal: 8 },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    borderBottomWidth: 2,
  },
  count: { borderWidth: 1, paddingHorizontal: 4, minWidth: 18, textAlign: 'center', fontSize: 11 },
  categories: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingTop: 6,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  card: { padding: 16, margin: 12, borderWidth: 1, gap: 12 },
  order: { marginLeft: 'auto', justifyContent: 'center', paddingHorizontal: 4 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 8 },
  input: { borderWidth: 1, minHeight: 80, padding: 10, textAlignVertical: 'top' },
  options: { gap: 8 },
  choice: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 10 },
  choiceText: { flex: 1, gap: 6 },
  discussion: { borderLeftWidth: 2, paddingLeft: 12, gap: 8 },
})
