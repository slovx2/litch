// 控制台里的一张议题卡：原帖、答复区、状态、讨论（底部抽屉）。控制台列表和对话里的半屏议题卡（IssueSheet）共用。
// 复用核心经理契约，正文沿用对话 Markdown，提案沿用正式操作组件。
import {
  type DeviceView,
  decisionDraftState,
  keys,
  MANAGER_ISSUE_ORDERS,
  type ManagerBoardTopicView,
  type ManagerView,
  managerAttentionCount,
  managerRequestStatus,
  postDraftState,
  requestDraftState,
  resetDecisionSelection,
  type SuggestionView,
  submitManagerRequest,
} from '@litch/core'
import { useIsFocused } from '@react-navigation/native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useContext, useEffect, useRef, useState } from 'react'
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  useWindowDimensions,
  View,
} from 'react-native'
import type { ManagerDecisionOption } from '../../../../../packages/protocol/src/manager.mjs'
import type { ManagerPost } from '../../../../../packages/protocol/src/manager-posts.mjs'
import { stamp } from '../../../../../packages/ui/src/app/format.ts'
import { readWhileOpen } from '../../../../../packages/ui/src/app/read.ts'
import {
  markRepliesSeen,
  newReplies,
  postCollapsed,
  postSummary,
  postViewKey,
  questionMode,
  rememberPostCollapsed,
} from '../../../../../packages/ui/src/manager/post-presentation.ts'
import {
  proposalSummary,
  shortObjectId,
} from '../../../../../packages/ui/src/tree/proposal-brief.ts'
import { useGrow } from '../../detail/composer/grow'
import { ProposalActs } from '../../detail/proposals/ProposalActs'
import type { RootStackParamList } from '../../nav/routes'
import { useChannel, useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button, Empty } from '../../ui/kit/controls'
import { Caret, Fold, Icon, IconButton } from '../../ui/kit/Icon'
import { ChoiceMark } from '../../ui/kit/marks'
import { Sheet } from '../../ui/kit/overlays'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { Byline } from './Byline'
import { animateNextLayout } from './card-motion'
import { readChoice, writeChoice } from './choice-drafts'
import { DecisionAnswer, DecisionHistory, DecisionOutcome } from './DecisionOutcome'
import { DiscussionDrawer } from './DiscussionDrawer'
import { DiscussionHistory } from './DiscussionHistory'
import { DraftEndedNote } from './DraftEndedNote'
import {
  baseFile,
  choiceFile,
  clearDrafts,
  questionFile as draftFile,
  editFile,
  replyFile,
} from './draft-files'
import { Markdown } from './IssueMarkdown'
import { IssueContext, IssueRelations } from './IssueRelations'
import { setIssueOrder, useIssueOrder } from './issue-order'
import { ManagerOverview } from './ManagerOverview'
import { decisionActions, issueCounts, orderedIssues } from './presentation'
import { SuggestionBrief } from './SuggestionBrief'
import { SuggestionMeta } from './SuggestionMeta'
import { useDraftsCleared } from './use-draft-files'

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
  const { c, radius, hit } = useTheme()
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
          flex: 1,
          minHeight: hit,
          borderColor: selected ? c.accent : c.line1,
          borderWidth: selected ? 2 : 1,
          borderRadius: radius.s,
          backgroundColor: pressed ? c.press : selected ? c.sunken : 'transparent',
        },
      ]}
    >
      <ChoiceMark kind="radio" state={selected ? 'on' : 'off'} />
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

// 抽屉打开才挂载输入框；增高钩子随输入框挂载，重开已有草稿也会立即测量。
function QuestionInput(props: TextInputProps) {
  const input = useRef<TextInput>(null)
  const grow = useGrow(input, props.value ?? '')
  return <TextInput {...props} ref={input} {...grow} />
}

export function Issue({
  manager,
  post,
  board,
  suggestions,
  talking,
  onTalk,
  onBack,
  onPosition,
  bare = false,
  inline = false,
}: {
  manager: ManagerView
  post: ManagerPost
  board: ManagerBoardTopicView['board']
  suggestions: readonly SuggestionView[]
  talking: boolean
  onTalk(open: boolean): void
  onBack(): void
  onPosition(y: number): void
  /** 在半屏议题卡里：不画卡片的边框和外边距（面板本身就是框） */
  bare?: boolean
  /** 分页列表已提供可折叠的卡头，详情只显示正文和讨论入口。 */
  inline?: boolean
}) {
  const t = useT()
  const { c, font, radius, hit } = useTheme()
  const narrow = useWindowDimensions().width < 360
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
  const [selectedMode, setMode] = useState<'manager' | 'temporary' | null>(null)
  const mode = questionMode(selectedMode, post.discussion.messages)
  // 讨论不内嵌在卡片里：卡片标题行只留入口，点开在底部抽屉里看问答、写追问
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
        decisionDraftState(
          board,
          found.id,
          baseFile.read()?.[draftKey] ?? found.revision,
          editFile.read()?.[draftKey],
        ).state !== 'ended',
    )
  })
  const [unreviewed, setUnreviewed] = useState(false)
  const viewKey = postViewKey(manager.deviceId, manager.id, post.id)
  const [savedCollapsed, setCollapsed] = useState(() =>
    postCollapsed(
      viewKey,
      post.kind === 'decision'
        ? board?.decisions.find((d) => d.id === post.id)?.status !== 'open'
        : post.kind === 'request'
          ? board?.requests?.find((r) => r.id === post.id)?.status !== 'open'
          : post.kind === 'report'
            ? !post.unread
            : false,
    ),
  )
  const collapsed = inline ? false : savedCollapsed
  const toggle = () => {
    animateNextLayout()
    rememberPostCollapsed(viewKey, !collapsed)
    setCollapsed(!collapsed)
  }
  /** 正在填忽略理由；null 是没在填 */
  const [requestIgnore, setRequestIgnore] = useState<{ revision: number; reason: string } | null>(
    null,
  )
  const [ignoring, setIgnoring] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [error, setError] = useState('')
  const locked = busy || manager.status !== 'active' || device?.connection !== 'online'
  // 比应用旧的设备服务没宣告的能力：入口禁用，旁边写明原因（看板顶上另有一行说去设备详情升级）
  const features = useContext(IssueContext)?.features ?? {
    feedback: true,
    requestIgnore: true,
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
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      inFlight.current = false
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
  // 底部提交条批量交出或清掉草稿后：丢掉卡片手里的旧草稿，重读文件；这张卡交掉了就退出修改状态
  const cleared = useDraftsCleared()
  const seenCleared = useRef(cleared)
  useEffect(() => {
    if (seenCleared.current === cleared) return
    seenCleared.current = cleared
    const nextReply = replyFile.read()?.[draftKey] ?? ''
    const nextChoice = readChoice(draftKey, options)
    setQuestion(draftFile.read()?.[draftKey] ?? '')
    setReply(nextReply)
    setChoiceState(nextChoice)
    if (!nextChoice && !nextReply.trim()) setEditing(false)
  }, [cleared, draftKey, options])
  const [confirmedRevision, setConfirmedRevision] = useState<number | null>(null)
  const [selectionReset, setSelectionReset] = useState(false)
  const resetSelection = Boolean(
    board &&
      decision &&
      resetDecisionSelection(board, {
        decisionId: decision.id,
        revision: base,
        optionId: choiceFile.read()?.[draftKey] ?? choice,
        text: reply,
        question,
      }),
  )
  useEffect(() => {
    if (!resetSelection || !decision) return
    try {
      writeChoice(draftKey, null)
      baseFile.write({ ...baseFile.read(), [draftKey]: decision.revision })
      if (choice) setSelectionReset(true)
      setChoiceState(null)
      setConfirmedRevision(decision.revision)
    } catch (e) {
      setError(String(e))
    }
  }, [resetSelection, decision, draftKey, choice])
  const answerState = !board
    ? null
    : decision
      ? decisionDraftState(board, decision.id, base, editFile.read()?.[draftKey]).state
      : request
        ? requestDraftState(board, request.id, base).state
        : null
  const answerConflict =
    answerState === 'conflict' && !resetSelection && confirmedRevision !== revision
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
      if (request && !answerConflict && !replyEnded) {
        const accepted = await submitManagerRequest(channel, manager.deviceId, manager.id, {
          requestId: request.id,
          revision: request.revision,
          delivered,
          text: reply,
        })
        if (!accepted) throw new Error(t('manager.requestSubmitFailed'))
        if (draftFile.read()?.[draftKey]?.trim())
          baseFile.write({ ...baseFile.read(), [draftKey]: accepted.revision })
        clearDrafts([draftKey], { reply: true })
        setReply('')
        setEditing(false)
      }
    })
  const submitDecision = (optionId: string | null) =>
    run(async () => {
      if (!decision || answerConflict || resetSelection) return
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
      ? t(`manager.request.${managerRequestStatus(request)}`)
      : post.kind === 'report'
        ? t(post.unread ? 'manager.reportUnread' : 'manager.reportRead')
        : ''
  const pending =
    drafted || decision?.status === 'open' || request?.status === 'open' || post.unread
  const events = post.discussion.messages
    .flatMap((q) => [
      ...(q.question
        ? [
            {
              id: `${q.id}-q`,
              at: q.at,
              who: t('manager.questionYou'),
              text: q.question,
              waiting: false,
            },
          ]
        : []),
      {
        id: `${q.id}-a`,
        at: q.answeredAt ?? q.at,
        who: t(
          q.mode === 'manager'
            ? 'manager.questionManagerSpeaker'
            : 'manager.questionTemporarySpeaker',
        ),
        // 还在等的回答不写成一段正文，名字后面挂一个“等待回复”的小标签
        waiting: q.status === 'running' && !q.answer && !q.updatedPost,
        text:
          q.answer ??
          (q.updatedPost
            ? t('manager.postUpdatedReply')
            : q.status === 'failed'
              ? t('manager.questionFailed')
              : q.status === 'running'
                ? ''
                : t('manager.questionPending')),
      },
    ])
    .sort((a, b) => a.at - b.at)
  // 入口：回复数，有新回复、在等回复或有没发出的追问时加一个小点；读屏名称写全
  const replies = post.discussion.messages.filter((q) => q.status !== 'running').length
  const seenKey = `${viewKey}/seen`
  useEffect(() => {
    if (talking) markRepliesSeen(seenKey, replies)
  }, [talking, seenKey, replies])
  const news = !talking && newReplies(seenKey, replies)
  const waiting = post.discussion.messages.some((q) => q.status === 'running')
  const unsent = Boolean(question.trim()) && !questionEnded
  const noTalk = !features.posts && !post.discussion.messages.length
  const entryLabel = [
    t('manager.discussionOpen'),
    replies ? t('manager.discussionCount', { n: replies }) : '',
    news ? t('manager.discussionNew') : '',
    waiting ? t('manager.discussionWaiting') : '',
    unsent ? t('manager.discussionDraft') : '',
    features.posts ? '' : t('manager.oldDeviceShort'),
  ]
    .filter(Boolean)
    .join(' · ')
  const entry = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={entryLabel}
      accessibilityState={{ expanded: talking, disabled: noTalk }}
      disabled={noTalk}
      testID={`post-discussion:${post.id}`}
      onPress={() => onTalk(true)}
      hitSlop={{ top: 6, bottom: 6 }}
      style={({ pressed }) => [
        styles.entry,
        // 转讨论的入口：强调色描边，醒目但不压过实心的快速处理主按钮
        {
          minHeight: 36,
          borderColor: noTalk ? c.line2 : c.accent,
          borderRadius: radius.l,
          backgroundColor: pressed || talking ? c.selBg : c.panel,
          opacity: noTalk ? 0.5 : 1,
        },
      ]}
    >
      <Icon name="note" size={16} color={noTalk ? c.ink2 : c.accent} />
      <Text
        style={{ color: noTalk ? c.ink2 : c.accent, fontSize: font.size.meta + 1, fontWeight: '600' }}
      >
        {t('manager.discussion')}
      </Text>
      {replies ? (
        <Text
          style={{
            color: c.accent,
            fontSize: font.size.small + 1,
            fontWeight: '600',
            fontVariant: ['tabular-nums'],
          }}
        >
          {replies}
        </Text>
      ) : null}
      {/* 设备服务较旧、没有讨论可读：入口禁用，原因写在入口上（看板顶上另有一行说去设备详情升级） */}
      {noTalk ? (
        <Text
          testID={`old-device-reason:posts:${post.id}`}
          style={{ color: c.ink3, fontSize: font.size.meta }}
        >
          {t('manager.oldDeviceShort')}
        </Text>
      ) : null}
      {news || waiting || unsent ? (
        <View
          style={[styles.dot, { backgroundColor: news ? c.accent : c.wait }]}
          testID={`post-discussion-dot:${post.id}`}
        />
      ) : null}
    </Pressable>
  )
  const compose = features.posts ? (
    <View style={styles.talkCompose}>
      {/* 只有能开临时对话时才给两种方式选；只有经理一种就不画切换 */}
      {canTemporary ? (
        <View accessibilityLabel={t('manager.questionMode')} style={styles.modes}>
          {(['manager', 'temporary'] as const).map((one) => (
            <Pressable
              key={one}
              accessibilityRole="button"
              accessibilityState={{ selected: mode === one }}
              testID={`post-question-mode:${one}`}
              hitSlop={{ top: 8, bottom: 8 }}
              onPress={() => setMode(one)}
              style={[styles.mode, { borderBottomColor: mode === one ? c.accent : 'transparent' }]}
            >
              <Text
                style={{
                  color: mode === one ? c.ink : c.ink3,
                  fontSize: font.size.meta,
                  fontWeight: mode === one ? '600' : '400',
                }}
              >
                {t(one === 'manager' ? 'manager.questionManager' : 'manager.questionTemporary')}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={styles.askRow}>
        <QuestionInput
          testID={`post-question:${post.id}`}
          multiline
          accessibilityLabel={questionPrompt}
          placeholder={questionPrompt}
          placeholderTextColor={c.ink3}
          style={[
            styles.input,
            styles.askInput,
            { color: c.ink, borderColor: c.line1, fontSize: font.size.body },
          ]}
          value={question}
          onChangeText={writeQuestion}
        />
        <IconButton
          icon="send"
          tone="solid"
          label={t('manager.postSubmit')}
          testID={`post-question-submit:${post.id}`}
          disabled={locked || !question.trim() || (mode === 'manager' && questionEnded)}
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
      </View>
      {mode === 'manager' && answerConflict ? (
        <Text style={{ color: c.ink2 }}>{t('manager.questionUpdated')}</Text>
      ) : null}
    </View>
  ) : (
    <Text style={{ color: c.ink2 }}>{t('manager.oldDeviceShort')}</Text>
  )
  const discussion = (
    <DiscussionDrawer
      visible={talking}
      id={post.id}
      title={post.title}
      onClose={() => onTalk(false)}
      onBack={onBack}
      footer={
        <>
          {compose}
          {error ? <Text style={{ color: c.err }}>{error}</Text> : null}
        </>
      }
    >
      {events.length ? (
        <DiscussionHistory
          viewKey={`${viewKey}/discussion`}
          text={post.discussion.messages.map((q) => `${q.question}\n${q.answer ?? ''}`).join('\n')}
          defaultOpen
        >
          <View style={styles.timeline}>
            {events.map((entry) => (
              <View key={entry.id} style={[styles.discussion, { borderColor: c.line1 }]}>
                <Byline
                  who={entry.who}
                  at={entry.at}
                  {...(entry.waiting
                    ? {
                        tag: {
                          text: t('manager.discussionWaiting'),
                          tone: 'wait' as const,
                          testID: `discussion-waiting:${entry.id}`,
                        },
                      }
                    : {})}
                />
                {entry.text ? <Markdown text={entry.text} /> : null}
              </View>
            ))}
          </View>
        </DiscussionHistory>
      ) : null}
    </DiscussionDrawer>
  )
  return (
    <View
      style={[
        styles.card,
        narrow ? styles.cardNarrow : null,
        bare ? styles.cardBare : null,
        inline ? styles.cardInline : null,
        { borderColor: talking ? c.accent : c.line1, backgroundColor: c.panel },
      ]}
      testID={`manager-issue:${post.id}`}
      onLayout={(event) => onPosition(event.nativeEvent.layout.y)}
    >
      <View style={[styles.cardHeader, inline ? styles.headerInline : null]}>
        {!inline ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(collapsed ? 'manager.postExpand' : 'manager.postCollapse')}
            accessibilityState={{ expanded: !collapsed }}
            testID={`post-collapse:${post.id}`}
            style={({ pressed }) => ({
              minHeight: hit,
              flex: 1,
              flexDirection: 'row',
              gap: 8,
              alignItems: 'flex-start',
              backgroundColor: pressed ? c.press : 'transparent',
            })}
            onPress={toggle}
          >
            {/* 箭头和标题第一行对齐（标题可能折成几行） */}
            <View style={styles.caret}>
              <Caret open={!collapsed} />
            </View>
            <Text style={{ color: c.ink, fontSize: font.size.title, fontWeight: '600', flex: 1 }}>
              <Text style={{ color: c.ink3, fontWeight: '400' }}>{shortObjectId(post.id)}</Text>{' '}
              {post.title}
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
            {selectionReset ? (
              <Text
                testID={`selection-reset:${post.id}`}
                numberOfLines={1}
                style={{ color: c.ink3, fontSize: font.size.small, flexShrink: 1 }}
              >
                {t('manager.selectionReset')}
              </Text>
            ) : null}
          </Pressable>
        ) : null}
        {!pendingReview || unreviewed ? entry : null}
      </View>
      {pendingReview ? (
        <Button
          kind="plain"
          label={t('suggestions.unreviewed')}
          onPress={() => setUnreviewed(!unreviewed)}
        />
      ) : null}
      {collapsed ? (
        // 收起时摘要也能点开（整张卡可点）；读屏和键盘走卡头按钮，这里不重复朗读
        <Pressable
          testID={`post-summary:${post.id}`}
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          onPress={toggle}
        >
          <Text numberOfLines={1} style={{ color: c.ink2, fontSize: font.size.body }}>
            {post.kind === 'suggestion'
              ? proposalSummary(
                  suggestion?.proposal.background,
                  suggestion?.proposal.prompt ?? post.body,
                )
              : postSummary(post.body)}
          </Text>
        </Pressable>
      ) : null}
      {decision?.status === 'ignored' ? (
        <Fold open={!collapsed} testID={`decision-ignored-toggle:${decision.id}`} onToggle={toggle}>
          <Text style={{ color: c.ink2 }}>
            {t(collapsed ? 'mgr.ignored.show' : 'mgr.ignored.hide')}
          </Text>
        </Fold>
      ) : null}
      {(!pendingReview || unreviewed) && !collapsed ? (
        <>
          {suggestion ? <SuggestionMeta row={suggestion} /> : null}
          <IssueRelations id={post.id} />
          {post.kind === 'suggestion' ? (
            <SuggestionBrief
              prompt={suggestion?.proposal.prompt ?? post.body}
              background={suggestion?.proposal.background}
              testID={`proposal:${post.proposalId ?? post.id}:brief`}
              renderText={Markdown}
            />
          ) : (
            <Markdown text={post.body} />
          )}
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
              sourceIsManager={suggestion.proposal.sourceIsManager}
              worktree={suggestion.proposal.worktree ?? false}
              wider={suggestion.proposal.widerSandbox}
            />
          ) : null}
          {decision || request ? null : endedNote}
          {request ? (
            <>
              {request.response ? <Markdown text={request.response.text} /> : null}
              {/* 先是你的回复，再说留着的草稿怎么办 */}
              {endedNote}
              {request.status === 'open' ? (
                <>
                  <Button
                    kind="plain"
                    testID={`request-ignore:${request.id}`}
                    label={t('manager.ignore')}
                    disabled={locked || !features.requestIgnore}
                    onPress={() => setRequestIgnore({ revision: request.revision, reason: '' })}
                  />
                  {oldReason('requestIgnore')}
                </>
              ) : null}
              {request.status === 'open' && requestIgnore ? (
                <View testID={`request-ignore-form:${request.id}`} style={styles.askComposer}>
                  <Text style={{ color: c.ink2 }}>{t('manager.requestIgnoreNote')}</Text>
                  <TextInput
                    testID={`request-ignore-reason:${request.id}`}
                    accessibilityLabel={t('manager.ignoreReason')}
                    placeholder={t('manager.ignoreReason')}
                    placeholderTextColor={c.ink3}
                    multiline
                    style={[styles.input, { color: c.ink, borderColor: c.line1 }]}
                    value={requestIgnore.reason}
                    editable={!locked}
                    onChangeText={(reason) => setRequestIgnore({ ...requestIgnore, reason })}
                  />
                  <Button
                    testID={`request-ignore-confirm:${request.id}`}
                    label={t('manager.ignoreConfirm')}
                    disabled={locked || !features.requestIgnore}
                    onPress={() =>
                      void run(async () => {
                        const accepted = await submitManagerRequest(
                          channel,
                          manager.deviceId,
                          manager.id,
                          {
                            requestId: request.id,
                            revision: requestIgnore.revision,
                            delivered: false,
                            text: requestIgnore.reason,
                            ignored: true,
                          },
                        )
                        if (!accepted) throw new Error(t('manager.requestSubmitFailed'))
                        setRequestIgnore(null)
                      })
                    }
                  />
                  <Button
                    kind="plain"
                    label={t('app.cancel')}
                    disabled={locked}
                    onPress={() => setRequestIgnore(null)}
                  />
                </View>
              ) : null}
              {request.status !== 'cancelled' &&
              !replyEnded &&
              (request.status === 'open' || editing) ? (
                <>
                  {answerConflict ? (
                    <View style={{ gap: 8 }}>
                      <Text style={{ color: c.ink2 }}>{t('manager.requestConflict')}</Text>
                      <Button
                        label={t('manager.confirm')}
                        disabled={locked}
                        onPress={() => {
                          baseFile.write({ ...baseFile.read(), [draftKey]: request.revision })
                          setConfirmedRevision(request.revision)
                        }}
                      />
                    </View>
                  ) : null}
                  <TextInput
                    testID={`request-reply:${request.id}`}
                    accessibilityLabel={t('manager.requestText')}
                    style={[styles.input, { color: c.ink, borderColor: c.line1 }]}
                    multiline
                    editable={features.feedback && !locked}
                    value={reply}
                    onChangeText={writeReply}
                  />
                  <Button
                    testID={`request-deliver:${request.id}`}
                    disabled={locked || !features.feedback || answerConflict}
                    label={request.buttonLabel ?? t('manager.requestDone')}
                    onPress={() => void submitReply(true)}
                  />
                  {reply.trim() ? (
                    <Button
                      kind="plain"
                      disabled={locked || !features.feedback || answerConflict}
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
                  {answerConflict ? (
                    <View style={styles.actions}>
                      <Text style={{ color: c.wait, fontSize: font.size.meta }}>
                        {t('manager.conflict')}
                      </Text>
                      <IconButton
                        icon="check"
                        color={c.accent}
                        label={t('manager.confirm')}
                        testID={`decision-confirm:${decision.id}`}
                        disabled={locked}
                        onPress={() => {
                          try {
                            baseFile.write({ ...baseFile.read(), [draftKey]: revision })
                            if (!decision.options.some((o) => o.id === choice)) setChoice(null)
                            setConfirmedRevision(revision)
                          } catch (e) {
                            setError(String(e))
                          }
                        }}
                      />
                    </View>
                  ) : null}
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
                            selected={!resetSelection && choice === o.id}
                            disabled={locked}
                            onSelect={() => setChoice(choice === o.id ? null : o.id)}
                          />
                        ))}
                      </View>
                      <TextInput
                        testID={`decision-input:${decision.id}`}
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
                          disabled={
                            locked || answerConflict || resetSelection || (!choice && !reply.trim())
                          }
                          label={t('manager.submit')}
                          onPress={() => void submitDecision(choice)}
                        />
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
                              setCollapsed(true)
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
                        editFile.write({ ...editFile.read(), [draftKey]: decision.revision })
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
        </>
      ) : null}
      {!pendingReview || unreviewed ? discussion : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: c.err }}>
          {error}
        </Text>
      ) : null}
    </View>
  )
}
const styles = StyleSheet.create({
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  caret: { height: 24, justifyContent: 'center' },
  status: { borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2 },
  askComposer: { gap: 10, borderLeftWidth: 2, padding: 12 },
  talkCompose: { gap: 6 },
  modes: { flexDirection: 'row', gap: 16, paddingHorizontal: 2 },
  mode: { paddingVertical: 4, borderBottomWidth: 2 },
  askRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 4 },
  askInput: { flex: 1, minHeight: 44, maxHeight: 160 },
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    minHeight: 30,
    paddingHorizontal: 10,
    borderWidth: 1,
  },
  dot: { position: 'absolute', top: -3, right: -3, width: 8, height: 8, borderRadius: 4 },
  card: { padding: 16, margin: 12, borderWidth: 1, gap: 12 },
  // 320 一类的小屏：外边距、内边距收窄，正文多出约 16 宽
  cardNarrow: { padding: 12, margin: 8 },
  cardBare: { padding: 0, margin: 0, borderWidth: 0 },
  // 分页列表里展开的卡：卡头由列表画，这里接着卡头往下排，不再套一层边框
  cardInline: { margin: 0, borderWidth: 0, paddingTop: 0, paddingHorizontal: 12 },
  headerInline: { justifyContent: 'flex-end' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 8 },
  input: { borderWidth: 1, minHeight: 80, maxHeight: 160, padding: 10, textAlignVertical: 'top' },
  options: { gap: 8 },
  choice: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 10 },
  choiceText: { flex: 1, gap: 6 },
  timeline: { gap: 16 },
  discussion: { borderLeftWidth: 2, paddingLeft: 12, gap: 6 },
})
