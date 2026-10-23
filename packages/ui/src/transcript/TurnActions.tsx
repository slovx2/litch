// 自己发过的一条消息上能做的两件事：从这里分叉成新会话、回退到这里改了重发。
// 平时不显示，鼠标到这条消息上或者键盘焦点进来才出现；不占排版的位置，出不出现对话都不会动。
// 回合开头那条按回合切；回合进行中插进来的话要 harness 会切在回合中间（can.cutInTurn）才有，
// 回退切在它之前，分叉带上它和模型回它的话、到下一条插进来的话之前（会切在回合中间时开头那条也这样带）。
import { type ItemView, keys, type SessionMeta, type TurnView } from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { whyNot } from '../app/errors.ts'
import { Fork, Rewind } from '../app/icons.tsx'
import { useKey, useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import { editDraftComments, refillDraft } from '../composer/drafts.ts'
import { useActions } from './actions.tsx'
import { commentsOf } from './comments/Cite.tsx'
import { findOrigin } from './comments/locate.ts'
import { MAX_COMMENTS, newCommentId } from './comments/model.ts'

interface TurnActionsProps {
  deviceId: string
  sessionId: string
  turnId: string
  /** 挂在哪条用户消息上 */
  itemId: string
  /** 它是回合进行中插进来的话，不是回合开头那条 */
  steered: boolean
}

export function TurnActions({ deviceId, sessionId, turnId, itemId, steered }: TurnActionsProps) {
  const { channel, replica } = useServices()
  const meta = useKey<SessionMeta>(keys.session(deviceId, sessionId))
  const { busy, open } = useActions()
  const t = useT()
  const [asking, setAsking] = useState(false)
  const [working, setWorking] = useState(false)

  /** 现在为什么做不了。能做就是 null */
  const blocked = (able: boolean | undefined): string | null =>
    able === false ? t('ability.unsupported') : busy ? t('turn.busy') : null
  const forkBlocked = blocked(meta?.can.fork)
  const rollbackBlocked = blocked(meta?.can.rollback)
  // 它所属的 harness 声明了不会的那一样：不出这个入口。
  // 没有声明的照旧留着能点：对面说不认识了，点了说为什么
  const declared = meta?.can.declared === true
  // 切在回合中间只认声明：插进来的话上，声明了会的才出
  const cut = meta?.can.cutInTurn === true
  const showFork = steered
    ? cut && meta?.can.fork === true
    : !(declared && meta?.can.fork === false)
  const showRollback = steered
    ? cut && meta?.can.rollback === true
    : !(declared && meta?.can.rollback === false)
  if (!showFork && !showRollback) return null

  const say = (text: string, tone: 'plain' | 'err' = 'err') =>
    showToast({ id: 'turn-action', tone, lifeMs: tone === 'err' ? 8000 : 4000, text: () => text })

  /** 这个回合里它后面那条自己插进来的话（分叉带到它之前）；别的会话发来的、只是一条系统提示的不算 */
  const nextSteer = (): string | null => {
    const ids = replica.store.get<TurnView>(keys.turn(deviceId, sessionId, turnId))?.itemIds ?? []
    for (const id of ids.slice(ids.indexOf(itemId) + 1)) {
      const item = replica.store.get<ItemView>(keys.item(deviceId, sessionId, id))
      if (item?.kind === 'userMessage' && !item.peer && (!item.event || item.text)) return id
    }
    return null
  }

  const fork = () => {
    if (working) return
    if (forkBlocked) return say(forkBlocked)
    const next = cut ? nextSteer() : null
    setWorking(true)
    channel
      .command('session.fork', {
        deviceId,
        sessionId,
        turnId,
        ...(next ? { itemId: next } : {}),
      })
      .then(
        (result) => {
          say(t('turn.fork.done'), 'plain')
          open?.({ deviceId, sessionId: result.sessionId })
        },
        (error: unknown) => say(t('turn.fork.failed', { reason: whyNot(error, t) })),
      )
      .finally(() => setWorking(false))
  }

  const rollback = () => {
    if (working) return
    // 回退之后这条消息就不在了：先把它的内容拿在手里，回退成了放回输入框给用户改
    const item = replica.store.get<ItemView>(keys.item(deviceId, sessionId, itemId))
    // 带着评论的：评论放回输入框上面（原文在哪条回答里要趁回退之前找），打的字放回输入框
    const said = item?.kind === 'userMessage' ? commentsOf(item.text) : null
    const comments = (said?.comments ?? []).map((comment) => ({
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
    channel
      .command('session.rollback', { deviceId, sessionId, turnId, ...(steered ? { itemId } : {}) })
      .then(
        () => {
          if (item?.kind !== 'userMessage') return
          const key = `${deviceId}:${sessionId}`
          if (comments.length > 0) {
            editDraftComments(key, (list) => [...comments, ...list].slice(0, MAX_COMMENTS))
          }
          refillDraft(
            key,
            said ? said.rest : item.text,
            item.attachments.flatMap((attachment) =>
              attachment.kind === 'image' && attachment.url
                ? [{ url: attachment.url, name: attachment.label }]
                : [],
            ),
          )
        },
        (error: unknown) => say(t('turn.rollback.failed', { reason: whyNot(error, t) })),
      )
      .finally(() => setWorking(false))
  }

  const forkTitle = forkBlocked ?? t('turn.fork')
  const rollbackTitle = rollbackBlocked ?? t('turn.rollback')
  return (
    <div className="umsg-acts">
      {/* 做不了的时候不用 disabled：那样鼠标放上去没有说明，点了也没反应。留着能点，点了说为什么 */}
      {showFork ? (
        <button
          type="button"
          className="ibtn act-fork"
          title={forkTitle}
          aria-label={forkTitle}
          aria-disabled={forkBlocked !== null || working}
          onClick={fork}
        >
          <Fork />
        </button>
      ) : null}
      {showRollback ? (
        <button
          type="button"
          className="ibtn act-rollback"
          title={rollbackTitle}
          aria-label={rollbackTitle}
          aria-disabled={rollbackBlocked !== null || working}
          onClick={() => {
            if (rollbackBlocked) say(rollbackBlocked)
            else if (!working) setAsking(true)
          }}
        >
          <Rewind />
        </button>
      ) : null}
      {asking ? (
        <Confirm
          title={t('turn.rollback.askTitle')}
          note={t(
            meta?.can.rollbackRestoresFiles
              ? 'turn.rollback.askNoteRestores'
              : 'turn.rollback.askNote',
          )}
          yes={t('turn.rollback.yes')}
          no={t('turn.rollback.no')}
          onYes={() => {
            setAsking(false)
            rollback()
          }}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </div>
  )
}
