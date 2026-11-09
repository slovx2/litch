// issue 的讨论区：评论、旧“问经理”问答与状态变化按时间排成一条；底部是评论框。
// 评论与问答分开：评论不回答决策、不交付请求（60 号设计 5.3）。草稿按 [设备, 经理, #n] 存在内存里，切卡不丢。
import { useContext, useRef, useState } from 'react'
import { managerIssueActivity } from '../../../../core/src/projection/manager-issue-activity.mts'
import type { ManagerIssue } from '../../../../protocol/src/manager-issues.mts'
import { useT } from '../../app/appearance.ts'
import { reasonOf } from '../../app/errors.ts'
import { Icon } from '../../app/icons.tsx'
import { Stamp } from '../../transcript/Stamp.tsx'
import { BoardMarkdown } from '../BoardMarkdown.tsx'
import { submitQuestionOnEnter } from '../post-presentation.ts'
import { RelationsContext } from '../Relations.tsx'

const drafts = new Map<string, string>()

type Row =
  | { kind: 'comment'; at: number; id: string; author: 'user' | 'manager'; body: string }
  | { kind: 'question'; at: number; id: string; question: string; answer: string | null }
  | { kind: 'event'; at: number; id: string; text: string }

export function IssueDiscussion({
  issue,
  changes,
  draftKey,
  disabled,
  reason,
  special,
  onComment,
  onAsk,
}: {
  issue: ManagerIssue
  changes?: readonly { id: string; fields: readonly string[] }[] | undefined
  draftKey: string
  disabled: boolean
  /** 不能评论时写在评论框上的原因 */
  reason: string
  special: boolean
  onComment(body: string): Promise<unknown>
  /** 有它时输入框上多一个“问经理”：发的是旧帖子追问，不是评论 */
  onAsk?: ((question: string) => Promise<unknown>) | undefined
}) {
  const t = useT()
  const relations = useContext(RelationsContext)
  const [text, setText] = useState(() => drafts.get(draftKey) ?? '')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [error, setError] = useState('')
  const [asking, setAsking] = useState(false)
  const edit = (value: string) => {
    setText(value)
    if (value) drafts.set(draftKey, value)
    else drafts.delete(draftKey)
  }
  const rows: Row[] = [
    ...issue.discussion.comments.map(
      (one): Row => ({
        kind: 'comment',
        at: one.createdAt,
        id: one.id,
        author: one.author.kind,
        body: one.body,
      }),
    ),
    ...issue.discussion.questions.map(
      (one): Row => ({
        kind: 'question',
        at: one.at,
        id: one.id,
        question: one.question,
        answer: one.answer,
      }),
    ),
    ...managerIssueActivity(issue.timeline, changes ?? relations?.board.changes).flatMap(
      (entry): Row[] => {
        // 评论、问答在上面单独画；创建写在卡头的元信息里
        // 设备把操作原因写在 summary 里（用户操作时由界面给出“状态改为 进行中”这样的话）；没有就用通用说法
        const who =
          entry.actor === 'manager' || entry.actor === 'user'
            ? `${t(entry.actor === 'manager' ? 'issue.author.manager' : 'issue.author.user')} · `
            : ''
        const what =
          entry.summary.trim() || t(`issue.timeline.${entry.kind}` as Parameters<typeof t>[0])
        return [{ kind: 'event', at: entry.at, id: entry.id, text: `${who}${what}` }]
      },
    ),
  ].sort((a, b) => a.at - b.at)
  const send = async () => {
    const body = text.trim()
    if (!body || busy || disabled || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      await (asking && onAsk ? onAsk(body) : onComment(body))
      edit('')
    } catch (cause) {
      setError(reasonOf(cause, t))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  const author = (who: 'user' | 'manager') =>
    t(who === 'manager' ? 'issue.author.manager' : 'issue.author.user')
  return (
    <section
      className="mg-issue-talk"
      data-issue-discussion={issue.id}
      aria-label={t('issue.comments')}
    >
      <header className="mg-issue-talk-head">
        <b>{t('issue.comments')}</b>
        <span className="mg-issue-count">{issue.discussion.comments.length}</span>
      </header>
      {rows.length ? (
        <ol className="mg-issue-timeline">
          {rows.map((row) =>
            row.kind === 'event' ? (
              <li key={row.id} className="mg-issue-event" data-timeline="event">
                <span className="mg-issue-event-dot" aria-hidden="true" />
                <span className="ell">{row.text}</span>
                <Stamp at={row.at} />
              </li>
            ) : row.kind === 'question' ? (
              <li key={row.id} className="mg-issue-comment" data-timeline="question">
                <header className="mg-issue-comment-head">
                  <b>{t('issue.timeline.question')}</b>
                  <Stamp at={row.at} />
                </header>
                <BoardMarkdown text={row.question} />
                {row.answer ? (
                  <blockquote className="mg-issue-answer">
                    <BoardMarkdown text={row.answer} />
                  </blockquote>
                ) : null}
              </li>
            ) : (
              <li
                key={row.id}
                className="mg-issue-comment"
                data-timeline="comment"
                data-author={row.author}
              >
                <header className="mg-issue-comment-head">
                  <b>{author(row.author)}</b>
                  <Stamp at={row.at} />
                </header>
                <BoardMarkdown text={row.body} />
              </li>
            ),
          )}
        </ol>
      ) : (
        <p className="mg-issue-note">{t('issue.comment.none')}</p>
      )}
      {special ? <p className="mg-issue-note">{t('issue.comment.note')}</p> : null}
      {issue.followUp.state === 'off' ? (
        <p className="mg-issue-note" data-follow-note>
          {t('issue.follow.pausedNote')}
        </p>
      ) : null}
      <div className="mg-post-compose mg-issue-compose">
        {onAsk ? (
          <fieldset className="mg-question-modes" aria-label={t('issue.mode')}>
            <button
              type="button"
              aria-pressed={!asking}
              data-issue-mode="comment"
              onClick={() => setAsking(false)}
            >
              {t('issue.comments')}
            </button>
            <button
              type="button"
              aria-pressed={asking}
              data-issue-mode="ask"
              onClick={() => setAsking(true)}
            >
              {t('issue.ask')}
            </button>
          </fieldset>
        ) : null}
        <textarea
          className="req-input mg-post-input grow-input"
          rows={2}
          value={text}
          disabled={disabled}
          title={disabled ? reason : undefined}
          placeholder={
            disabled ? reason : t(asking ? 'issue.ask.placeholder' : 'issue.comment.placeholder')
          }
          aria-label={t('issue.comment.placeholder')}
          data-issue-comment-input
          onChange={(event) => edit(event.target.value)}
          onKeyDown={(event) => {
            if (!submitQuestionOnEnter(event.nativeEvent)) return
            event.preventDefault()
            void send()
          }}
        />
        <button
          type="button"
          className="ibtn mg-post-send"
          data-act="issue-comment"
          title={disabled ? reason : t(asking ? 'issue.ask.send' : 'issue.comment.send')}
          aria-label={t(asking ? 'issue.ask.send' : 'issue.comment.send')}
          disabled={disabled || busy || !text.trim()}
          onClick={() => void send()}
        >
          <Icon name="send" small />
        </button>
        {error ? (
          <p className="err" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  )
}
