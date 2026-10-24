// 在原消息上编辑再重发（消息上的“编辑”打开）。气泡原地换成编辑框，带着原文；下面写发送后会怎样、哪些附件带不上。
// 点“发送”之前什么都不改：对话不切，输入框不动；“取消”或 Esc 恢复原样。
// 发送走 session.edit：先回退到这条消息之前（插进来的话切在它之前），成了再用编辑后的文字开新回合。
// - 回退没成：编辑框和里面的字都留着，下面写原因；
// - 回退成了、发送没成：原消息已经撤掉，编辑后的文字、图片、评论放回输入框，提示原因（和以前回退一样）。
// 评论不在这里改，原样带上；能显示的图片带上；带不上的附件写明（core 的 editableOf / resendOf）。
import { editableOf, type ItemView, keys, resendOf, type SessionMeta } from '@litch/core'
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import { editDraftComments, refillDraft } from '../composer/drafts.ts'
import { useActions } from './actions.tsx'
import { SentComments } from './comments/Cards.tsx'
import { commentsOf } from './comments/Cite.tsx'
import { findOrigin } from './comments/locate.ts'
import { MAX_COMMENTS, newCommentId } from './comments/model.ts'
import { UserAttachments } from './messages.tsx'

/** 编辑框最高多少像素，再多就在框里滚 */
const MAX_HEIGHT = 320

interface MessageEditProps {
  deviceId: string
  sessionId: string
  turnId: string
  itemId: string
  /** 它是回合进行中插进来的话：切在它之前 */
  steered: boolean
  /** 编辑结束（取消了，或者发出去了） */
  onDone(): void
}

export function MessageEdit({
  deviceId,
  sessionId,
  turnId,
  itemId,
  steered,
  onDone,
}: MessageEditProps) {
  const { channel, replica } = useServices()
  const meta = useKey<SessionMeta>(keys.session(deviceId, sessionId))
  const item = useKey<ItemView>(keys.item(deviceId, sessionId, itemId))
  const { busy } = useActions()
  const t = useT()
  const user = item?.kind === 'userMessage' ? item : null
  const [start] = useState(() => (user ? editableOf(user) : null))
  const [text, setText] = useState(start?.text ?? '')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const area = useRef<HTMLTextAreaElement | null>(null)

  // 打开时光标放在最后；字多了框跟着长，到顶了在框里滚
  useLayoutEffect(() => {
    const element = area.current
    if (!element) return
    element.focus()
    element.setSelectionRange(element.value.length, element.value.length)
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: 字变了要重新量高度
  useLayoutEffect(() => {
    const element = area.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`
  }, [text])

  if (!user || !start) return null
  const comments = commentsOf(user.text)
  const empty = !text.trim() && start.kept.length === 0 && start.comments === 0
  const blocked = busy
    ? t('turn.busy')
    : meta?.can.rollback === false
      ? t('ability.unsupported')
      : null

  const send = () => {
    if (working || empty) return
    // 回合在跑、harness 不会回退：不发，写明原因
    if (blocked) {
      setError(t('turn.edit.failed', { reason: blocked }))
      return
    }
    const message = resendOf(user, text)
    // 发送没成时评论放回输入框上面：原文在哪条回答里要趁回退之前找
    const drafted = (comments?.comments ?? []).map((comment) => ({
      id: newCommentId(),
      itemId:
        findOrigin(replica.store, { deviceId, sessionId, quote: comment.quote, before: itemId })
          ?.itemId ?? itemId,
      quote: comment.quote,
      note: comment.note,
      start: 0,
      end: comment.quote.length,
      raw: comment.quote,
    }))
    setWorking(true)
    setError(null)
    channel
      .command('session.edit', {
        deviceId,
        sessionId,
        turnId,
        ...(steered ? { itemId } : {}),
        ...message,
      })
      .then(
        (result) => {
          if (result.sendFailure) {
            const key = `${deviceId}:${sessionId}`
            if (drafted.length > 0)
              editDraftComments(key, (list) => [...drafted, ...list].slice(0, MAX_COMMENTS))
            refillDraft(key, text, message.images)
            showToast({
              id: 'turn-action',
              tone: 'err',
              lifeMs: 8000,
              text: () => t('turn.edit.sendFailed', { reason: whyNot(result.sendFailure, t) }),
            })
          }
          onDone()
        },
        (failure: unknown) => {
          setWorking(false)
          setError(t('turn.edit.failed', { reason: whyNot(failure, t) }))
        },
      )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (!working) onDone()
      return
    }
    if (event.key !== 'Enter' || event.shiftKey) return
    // 输入法还在选词：这个回车是确认候选
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    send()
  }

  return (
    <div className="umsg editing" data-anchor={`u:${itemId}`}>
      {comments ? (
        <SentComments
          deviceId={deviceId}
          sessionId={sessionId}
          itemId={itemId}
          comments={comments.comments}
        />
      ) : null}
      {start.kept.length > 0 ? <UserAttachments attachments={start.kept} /> : null}
      <textarea
        ref={area}
        className="umsg-edit"
        aria-label={t('turn.edit.editing')}
        value={text}
        disabled={working}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {start.dropped.length > 0 ? (
        <div className="umsg-edit-note">
          {t('turn.edit.dropped', {
            names: start.dropped
              .map((one) => one.label ?? t(`attachment.${one.kind}`))
              .join(t('list.comma')),
          })}
        </div>
      ) : null}
      <div className="umsg-edit-note">
        {t(meta?.can.rollbackRestoresFiles ? 'turn.edit.noteRestores' : 'turn.edit.note')}
      </div>
      {error ? (
        <div className="umsg-edit-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="umsg-edit-bar">
        <button type="button" className="btn ghost" disabled={working} onClick={onDone}>
          {t('turn.edit.cancel')}
        </button>
        <button
          type="button"
          className="btn primary"
          aria-disabled={empty || working || blocked !== null}
          title={blocked ?? undefined}
          onClick={send}
        >
          {t('turn.edit.send')}
        </button>
      </div>
    </div>
  )
}
