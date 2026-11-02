// 四类对象共用帖子记录；原帖在宿主卡片顶部，讨论区只负责历史和追问。
import { type DeviceView, keys, postDraftState } from '@litch/core'
import { useEffect, useId, useRef, useState } from 'react'
import type { ManagerBoardTopicView, ManagerView } from '../../../core/src/model-manager.mts'
import type { ManagerPost } from '../../../protocol/src/manager-posts.mjs'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { Stamp } from '../transcript/Stamp.tsx'
import { BoardMarkdown } from './BoardMarkdown.tsx'
import { DiscussionHistory } from './DiscussionHistory.tsx'
import { DraftEnded } from './DraftEnded.tsx'
import { useManagerFeatures } from './data.ts'
import { usePostDrafts } from './post-drafts.ts'
import {
  hasTemporaryQuestions,
  postViewKey,
  questionMode,
  submitQuestionOnEnter,
} from './post-presentation.ts'

export function usePost(manager: ManagerView, id: string) {
  return useKey<ManagerBoardTopicView>(
    keys.managerBoard(manager.deviceId, manager.id),
  )?.board?.posts?.find((post) => post.id === id)
}
export function PostHistory({ post }: { post: ManagerPost | undefined }) {
  const t = useT()
  if (!post?.versions.length) return null
  return (
    <details className="mg-post-history">
      <summary>
        {t('manager.postEdited')} · <Stamp at={post.updatedAt} /> · {t('manager.postHistory')}
      </summary>
      {post.versions.map((v) => (
        <article key={`${v.revision}-${v.at}`}>
          <header>
            <b>
              v{v.revision} · {v.title}
            </b>{' '}
            <Stamp at={v.at} />
          </header>
          <BoardMarkdown text={v.why} />
          <BoardMarkdown text={v.body} />
        </article>
      ))}
    </details>
  )
}
export function PostDiscussion({
  manager,
  post,
  disabled = false,
  question,
  onQuestion,
  questionBlocked = false,
  compact = false,
}: {
  manager: ManagerView
  post: ManagerPost | undefined
  disabled?: boolean
  compact?: boolean
  questionBlocked?: boolean
  question?: string
  onQuestion?(text: string): void
}) {
  const t = useT()
  const { channel } = useServices()
  const device = useKey<DeviceView>(keys.device(manager.deviceId))
  const board = useKey<ManagerBoardTopicView>(
    keys.managerBoard(manager.deviceId, manager.id),
  )?.board
  const [open, setOpen] = useState(false)
  const inputId = useId()
  const submitted = useRef(0)
  const count = post?.discussion.messages.length ?? 0
  // 混合提交由宿主执行；确认设备新增记录后也收起编辑区。
  useEffect(() => {
    if (count > submitted.current) setOpen(false)
    submitted.current = count
  }, [count])
  const [selectedMode, setMode] = useState<'manager' | 'temporary' | null>(null)
  const { drafts, write } = usePostDrafts(manager.deviceId, manager.id)
  const draft = post ? drafts[post.id] : undefined
  const [temporary, setTemporary] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const features = useManagerFeatures()
  // 比应用旧的设备服务：议题追问要 Posts，决策上的追问随答复一起交、还要 Feedback
  const old = !features.posts || (Boolean(onQuestion) && !features.feedback)
  if (!post) return null
  const messages = post.discussion.messages
  const mode = questionMode(selectedMode, messages)
  const direct = hasTemporaryQuestions(messages)
  const expanded = (!compact && open) || direct
  const running = messages.some((q) => q.status === 'running' && q.mode !== 'manager')
  const locked = disabled || busy || running || (mode === 'manager' && questionBlocked)
  const canTemporary =
    device?.harnesses.find((h) => h.id === manager.harness)?.abilities?.managerQuestions === true
  const value = mode === 'temporary' ? temporary : (question ?? draft?.question ?? '')
  // 议题已结束（请你做取消、建议已处理）：追问草稿留着但不计数、不提交；决策上的追问由决策卡片管
  const ended = Boolean(
    !onQuestion &&
      draft?.question.trim() &&
      board &&
      postDraftState(board, post.id, draft.revision).state === 'ended',
  )
  const change = (value: string) => {
    if (mode === 'temporary') {
      setTemporary(value)
      return
    }
    if (onQuestion) {
      onQuestion(value)
      return
    }
    try {
      const next = { ...drafts }
      if (value.trim())
        next[post.id] = { id: post.id, revision: draft?.revision ?? post.revision, question: value }
      else delete next[post.id]
      write(next)
      setError('')
    } catch {
      setError(t('manager.savedFail'))
    }
  }
  const send = async () => {
    if (locked || old || !value.trim() || (ended && mode === 'manager')) return
    setBusy(true)
    setError('')
    try {
      await channel.command('managers.post.question', {
        deviceId: manager.deviceId,
        managerId: manager.id,
        id: post.id,
        revision:
          mode === 'manager' && !onQuestion ? (draft?.revision ?? post.revision) : post.revision,
        question: value.trim(),
        mode,
      })
      change('')
      setOpen(false)
    } catch (e) {
      setError(reasonOf(e, t))
    } finally {
      setBusy(false)
    }
  }
  const forward = async () => {
    setBusy(true)
    try {
      await channel.command('managers.post.forward', {
        deviceId: manager.deviceId,
        managerId: manager.id,
        id: post.id,
      })
      setError('')
    } catch (e) {
      setError(reasonOf(e, t))
    } finally {
      setBusy(false)
    }
  }
  const events = messages
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
        text:
          q.answer ??
          (q.updatedPost
            ? t('manager.postUpdatedReply')
            : t(q.status === 'failed' ? 'manager.questionFailed' : 'manager.questionPending')),
        waiting: q.status === 'running',
      },
    ])
    .sort((a, b) => a.at - b.at)
  return (
    <section className="mg-post-discussion" data-post={post.id}>
      {ended && draft ? (
        <DraftEnded
          text={t('manager.draftEnded.post')}
          onDiscard={() => {
            try {
              const { [post.id]: _discarded, ...rest } = drafts
              write(rest)
              setError('')
            } catch {
              setError(t('manager.savedFail'))
            }
          }}
        >
          <BoardMarkdown text={draft.question} />
        </DraftEnded>
      ) : null}
      {!compact && events.length ? (
        <DiscussionHistory
          viewKey={postViewKey(manager.deviceId, manager.id, `${post.id}/discussion`)}
          text={events.map((event) => event.text).join('\n')}
        >
          <ol className="mg-post-timeline">
            {events.map((e) => (
              <li key={e.id} className="mg-post-entry">
                <header>
                  <b>{e.who}</b> <Stamp at={e.at} />
                </header>
                <BoardMarkdown text={e.text} />
              </li>
            ))}
          </ol>
        </DiscussionHistory>
      ) : null}
      {!direct && !compact ? (
        <button
          type="button"
          className="btn ghost"
          data-act="post-ask"
          aria-expanded={open && !old}
          aria-controls={`${inputId}-compose`}
          disabled={old}
          title={old ? t('manager.oldDeviceShort') : undefined}
          onClick={() => setOpen(!open)}
        >
          {/* 展开收起只看箭头和 aria-expanded，文字一直是“追问”：下面不再另写标签 */}
          <span aria-hidden="true">{open && !old ? '▾' : '▸'}</span> {t('manager.postAsk')}
          {value.trim() && !ended ? ` · ${t('manager.draft')}` : ''}
        </button>
      ) : null}
      {old ? (
        <span className="dim" data-old-device-reason>
          {' '}
          {t('manager.oldDeviceShort')}
        </span>
      ) : null}
      {expanded && !old ? (
        <div className="mg-post-compose" id={`${inputId}-compose`}>
          <fieldset className="mg-question-modes" aria-label={t('manager.questionMode')}>
            <button
              type="button"
              data-question-mode="manager"
              aria-pressed={mode === 'manager'}
              onClick={() => setMode('manager')}
            >
              {t('manager.questionManager')}
            </button>
            {canTemporary ? (
              <button
                type="button"
                data-question-mode="temporary"
                aria-pressed={mode === 'temporary'}
                onClick={() => setMode('temporary')}
              >
                {t('manager.questionTemporary')}
              </button>
            ) : null}
          </fieldset>
          <textarea
            id={inputId}
            className="req-input mg-post-input"
            // 未单独发送的经理追问仍随答复一起交；操作说明只放占位。
            placeholder={t(
              mode === 'temporary'
                ? 'manager.questionTemporaryPlaceholder'
                : onQuestion
                  ? 'manager.questionDraftPlaceholder'
                  : 'manager.questionManagerPlaceholder',
            )}
            rows={3}
            maxLength={20000}
            value={value}
            disabled={locked}
            aria-label={t('manager.questionInput')}
            data-act="manager-question-input"
            onChange={(e) => change(e.target.value)}
            onKeyDown={(event) => {
              if (!submitQuestionOnEnter(event.nativeEvent)) return
              event.preventDefault()
              void send()
            }}
          />
          <button
            type="button"
            className="ic"
            aria-label={t('manager.postSubmit')}
            title={t('manager.postSubmit')}
            disabled={locked || !value.trim() || (ended && mode === 'manager')}
            onClick={() => void send()}
            data-act="post-question-send"
          >
            <span aria-hidden="true">↑</span>
          </button>
        </div>
      ) : null}
      {mode === 'temporary' && messages.length ? (
        <button
          type="button"
          className="ic"
          aria-label={t(
            post.discussion.forwarded === messages.length
              ? 'manager.questionForwarded'
              : 'manager.questionForward',
          )}
          data-act="manager-question-forward"
          disabled={locked || old || post.discussion.forwarded === messages.length}
          title={
            old
              ? t('manager.oldDeviceShort')
              : t(
                  post.discussion.forwarded === messages.length
                    ? 'manager.questionForwarded'
                    : 'manager.questionForward',
                )
          }
          onClick={() => void forward()}
        >
          <span aria-hidden="true">↗</span>
        </button>
      ) : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}
