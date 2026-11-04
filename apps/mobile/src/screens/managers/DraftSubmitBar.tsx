// 控制台底部的批量提交条（与桌面同一套规则）：这个经理名下各卡的草稿一起交，固定在列表下面，不随卡片滚动。
// 有草稿才出现；交完留一会儿报“已提交”。草稿判断用 core 的 liveManagerDrafts，失效的不计、不交。
import type { ManagerBoardTopicView, ManagerView } from '@litch/core'
import { useEffect, useState } from 'react'
import { Keyboard, Pressable, Text, View } from 'react-native'
import {
  liveManagerDrafts,
  type ManagerDraftBoard,
} from '../../../../../packages/core/src/projection/manager-drafts.mts'
import type { ManagerPostId } from '../../../../../packages/protocol/src/manager-posts.mts'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { Sheet } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'
import { baseFile, choiceFile, clearDrafts, questionFile, replyFile } from './draft-files'
import { useDraftVersion } from './use-draft-files'

type Board = NonNullable<ManagerBoardTopicView['board']>
type DecisionId = `D-${number}`
type RequestId = `R-${number}`

/** 从几份草稿文件里收出这个经理的草稿，按 core 的草稿形状排好 */
function collect(board: ManagerDraftBoard, full: Board, manager: ManagerView) {
  const choices = choiceFile.read() ?? {}
  const replies = replyFile.read() ?? {}
  const questions = questionFile.read() ?? {}
  const bases = baseFile.read() ?? {}
  const keys = new Map<string, string>()
  for (const key of new Set([
    ...Object.keys(choices),
    ...Object.keys(replies),
    ...Object.keys(questions),
  ])) {
    try {
      const [deviceId, managerId, id] = JSON.parse(key) as [string, string, string]
      if (deviceId === manager.deviceId && managerId === manager.id) keys.set(id, key)
    } catch {
      // 坏键不算草稿
    }
  }
  const decisions = []
  const requests = []
  const posts = []
  for (const [id, key] of keys) {
    const decision = board.decisions.find((one) => one.id === id)
    const options = full.decisions.find((one) => one.id === id)?.options
    const revision =
      bases[key] ??
      decision?.revision ??
      board.requests?.find((one) => one.id === id)?.revision ??
      board.posts?.find((one) => one.id === id)?.revision ??
      1
    const text = replies[key] ?? ''
    const question = questions[key] ?? ''
    if (id.startsWith('D-')) {
      // 经理改掉了那个选项就当没选（与卡片上的 readChoice 一致）
      const optionId = choices[key] ?? null
      const valid = !optionId || !options || options.some((one) => one.id === optionId)
      decisions.push({
        decisionId: id as DecisionId,
        revision,
        optionId: valid ? optionId : null,
        text,
        question,
      })
      continue
    }
    if (id.startsWith('R-') && text.trim())
      requests.push({ requestId: id as RequestId, revision, delivered: false, text })
    // 议题追问：卡片上按议题当前版本发，这里一样
    if (question.trim())
      posts.push({
        id,
        revision: board.posts?.find((one) => one.id === id)?.revision ?? revision,
        question,
      })
  }
  return { keys, drafts: { decisions, requests, posts } }
}

/** 键盘弹起时让出位置 */
function useKeyboardShown() {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setShown(true))
    const hide = Keyboard.addListener('keyboardDidHide', () => setShown(false))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])
  return shown
}

export function DraftSubmitBar({
  manager,
  board,
  draftBoard,
  features,
  disabled,
  onLocate,
  next,
}: {
  manager: ManagerView
  board: Board
  /** 分页看板补了卡头的判断面（core 的 pagedDraftBoard）；不分页就是 board */
  draftBoard: ManagerDraftBoard
  features: { feedback: boolean; posts: boolean }
  disabled: boolean
  /** 点草稿数：滚到下一张有草稿的卡 */
  onLocate?: (() => void) | undefined
  /** “下一个”（分页看板的决策列表才有）：展开下一个待答的决策；没有时置灰 */
  next?: { go(): void; disabled: boolean } | undefined
}) {
  const t = useT()
  const { c, font, hit, radius } = useTheme()
  const channel = useChannel()
  useDraftVersion()
  const keyboard = useKeyboardShown()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(0)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!sent) return
    const timer = setTimeout(() => setSent(0), 2500)
    return () => clearTimeout(timer)
  }, [sent])
  const { keys, drafts } = collect(draftBoard, board, manager)
  const live = liveManagerDrafts(draftBoard, drafts)
  // 比应用旧的设备服务：没宣告 Feedback 只交决策答复，没宣告 Posts 不交议题追问；留着等升级（同桌面）
  const answers = live.answers.map(({ question: _question, ...answer }) => answer)
  const questions = features.feedback
    ? live.questions.map((draft) => ({
        decisionId: draft.decisionId,
        revision: draft.revision,
        question: draft.question?.trim() ?? '',
      }))
    : []
  const requests = features.feedback ? live.requests : []
  const posts = features.posts ? live.posts : []
  const held =
    live.questions.length -
    questions.length +
    live.requests.length -
    requests.length +
    live.posts.length -
    posts.length
  const ended = live.ended.decisions.size + live.ended.requests.size + live.ended.posts.size
  const count =
    new Set([...answers, ...questions].map((entry) => entry.decisionId)).size +
    requests.length +
    posts.length
  const conflict = live.conflict || (features.feedback && live.requestConflict)
  const asking = [...answers, ...questions].some((entry) =>
    board.decisions
      .find((decision) => decision.id === entry.decisionId)
      ?.discussion?.messages.some(
        (message) => message.status === 'running' && message.mode !== 'manager',
      ),
  )
  const blocked = !count
    ? t('manager.oldDeviceShort')
    : asking
      ? t('manager.questionWait')
      : conflict
        ? t(live.conflict ? 'manager.conflict' : 'manager.requestConflict')
        : disabled
          ? t('manager.offline')
          : ''
  const keyOf = (id: string) => keys.get(id) ?? ''
  const submit = async () => {
    if (busy || blocked) return
    setBusy(true)
    setError('')
    try {
      const result =
        answers.length || questions.length || requests.length
          ? await channel.command('managers.feedback.submit', {
              deviceId: manager.deviceId,
              managerId: manager.id,
              answers,
              questions,
              requests,
            })
          : null
      if (result) {
        clearDrafts(
          result.accepted.map((one) => keyOf(one.id)),
          { choice: true, reply: true },
        )
        clearDrafts(
          result.acceptedQuestions.map((one) => keyOf(one.id)),
          { question: true },
        )
        clearDrafts(
          result.acceptedRequests.map((one) => keyOf(one.id)),
          { reply: true },
        )
      }
      for (const post of posts) {
        await channel.command('managers.post.question', {
          deviceId: manager.deviceId,
          managerId: manager.id,
          id: post.id as ManagerPostId,
          revision: post.revision,
          question: post.question,
          mode: 'manager',
        })
        clearDrafts([keyOf(post.id)], { question: true })
      }
      const rejected = [...(result?.rejected ?? []), ...(result?.rejectedQuestions ?? [])].map(
        (entry) => `${entry.decisionId}: ${entry.message}`,
      )
      const rejectedRequests = (result?.rejectedRequests ?? []).map(
        (entry) => `${entry.requestId}: ${entry.message}`,
      )
      if (rejected.length || rejectedRequests.length)
        setError(t('manager.rejected', { reason: [...rejected, ...rejectedRequests].join(' · ') }))
      else setSent(count)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  if (keyboard) return null
  const row = {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: hit,
    paddingHorizontal: 12,
    borderTopWidth: 1,
    borderTopColor: c.line2,
    backgroundColor: c.panel,
  } as const
  // 只剩失效的草稿不出条（同桌面）：失效的在卡头上标着，丢弃在卡里
  if (!count && !held)
    return sent ? (
      <View testID="draft-bar-sent" accessibilityRole="summary" style={row}>
        <Text style={{ color: c.ok, fontSize: font.size.body }}>
          ✓ {t('manager.sent', { n: sent })}
        </Text>
      </View>
    ) : null
  return (
    <View testID="draft-bar">
      {error || (blocked && count) ? (
        <Text
          testID="draft-bar-note"
          accessibilityRole="alert"
          numberOfLines={2}
          style={{
            color: error ? c.err : c.wait,
            fontSize: font.size.meta,
            paddingHorizontal: 12,
            paddingTop: 6,
            backgroundColor: c.panel,
            borderTopWidth: 1,
            borderTopColor: c.line2,
          }}
        >
          {error || blocked}
        </Text>
      ) : null}
      <View style={row}>
        <Pressable
          testID="draft-bar-locate"
          accessibilityRole="button"
          accessibilityLabel={`${t('manager.draftCount', { n: count })}，${t('manager.locateDraft')}`}
          onPress={onLocate}
          disabled={!onLocate}
          style={{ flexShrink: 1, minHeight: hit, justifyContent: 'center' }}
        >
          <Text numberOfLines={1} style={{ color: c.ink, fontSize: font.size.body }}>
            {t('manager.draftCount', { n: count })}
            {onLocate ? ' ↓' : ''}
            {ended || held ? (
              <Text style={{ color: c.ink3, fontSize: font.size.meta }}>
                {ended ? ` · ${t('manager.endedShort', { n: ended })}` : ''}
                {held ? ` · ${t('manager.heldShort', { n: held })}` : ''}
              </Text>
            ) : null}
          </Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable
          testID="draft-bar-clear"
          accessibilityRole="button"
          accessibilityLabel={t('manager.clear')}
          disabled={busy}
          onPress={() => setConfirming(true)}
          style={({ pressed }) => ({
            minWidth: hit,
            minHeight: hit,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? c.press : 'transparent',
          })}
        >
          <Text style={{ color: c.ink2, fontSize: font.size.title }}>✕</Text>
        </Pressable>
        {next ? (
          // 积极但不抢提交：强调色描边小按钮，只占一个触控高度
          <Pressable
            testID="draft-bar-next"
            accessibilityRole="button"
            accessibilityState={{ disabled: next.disabled }}
            accessibilityLabel={
              next.disabled
                ? `${t('manager.nextDecision')}，${t('manager.nextNone')}`
                : t('manager.nextHint')
            }
            disabled={next.disabled}
            onPress={next.go}
            style={({ pressed }) => ({
              minHeight: hit - 8,
              paddingHorizontal: 10,
              justifyContent: 'center',
              borderWidth: 1,
              borderRadius: radius.s,
              borderColor: next.disabled ? c.line2 : c.accent,
              backgroundColor: pressed ? c.press : 'transparent',
              opacity: next.disabled ? 0.5 : 1,
            })}
          >
            <Text style={{ color: next.disabled ? c.ink3 : c.accent, fontSize: font.size.body }}>
              {t('manager.nextDecision')} ↓
            </Text>
          </Pressable>
        ) : null}
        <Button
          testID="draft-bar-submit"
          label={t(busy ? 'manager.submitting' : 'manager.submitShort')}
          busy={busy}
          disabled={Boolean(blocked) || disabled}
          spoken={blocked ? `${t('manager.submit')}，${blocked}` : t('manager.submit')}
          onPress={() => void submit()}
        />
      </View>
      <Sheet
        visible={confirming}
        title={t('manager.clear')}
        note={t('manager.clearNote')}
        onClose={() => setConfirming(false)}
        actions={[
          {
            label: t('manager.clear'),
            testID: 'draft-bar-clear-confirm',
            danger: true,
            onPress: () => {
              setConfirming(false)
              setError('')
              clearDrafts(keys.values(), { choice: true, reply: true, question: true })
            },
          },
        ]}
      />
    </View>
  )
}
