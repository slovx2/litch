// 自己发过的一条消息上能做的两件事：从这里分叉成新会话、在原消息上编辑再重发（MessageEdit.tsx）。
// 平时不显示，鼠标到这条消息上或者键盘焦点进来才出现；不占排版的位置，出不出现对话都不会动。
// 回合开头那条消息还在最左边写发送的时刻（回合开始的时刻，照 Codex 桌面端也是悬停才出）。
// 回合开头那条按回合切；回合进行中插进来的话要 harness 会切在回合中间（can.cutInTurn）才有，
// 编辑重发切在它之前，分叉带上它和模型回它的话、到下一条插进来的话之前（会切在回合中间时开头那条也这样带）。
import { type ItemView, keys, type SessionMeta, type TurnView } from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { Fork, Pencil } from '../app/icons.tsx'
import { useKey, useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import { useActions } from './actions.tsx'
import { Stamp } from './Stamp.tsx'
import { messageActions } from './turn-actions.ts'

interface TurnActionsProps {
  deviceId: string
  sessionId: string
  turnId: string
  /** 挂在哪条用户消息上 */
  itemId: string
  /** 它是回合进行中插进来的话，不是回合开头那条 */
  steered: boolean
  /** 点了“编辑”：消息原地换成编辑框 */
  onEdit(): void
}

export function TurnActions({
  deviceId,
  sessionId,
  turnId,
  itemId,
  steered,
  onEdit,
}: TurnActionsProps) {
  const { channel, replica } = useServices()
  const meta = useKey<SessionMeta>(keys.session(deviceId, sessionId))
  const message = useKey<ItemView>(keys.item(deviceId, sessionId, itemId))
  const turn = useKey<TurnView>(keys.turn(deviceId, sessionId, turnId))
  // 插进来的话没有自己的时刻（条目上不带），只给回合开头那条写
  const sentAt = steered ? null : (turn?.startedAt ?? null)
  const { busy, open } = useActions()
  const t = useT()
  const [working, setWorking] = useState(false)

  /** 现在为什么做不了。能做就是 null */
  const blocked = (able: boolean | undefined): string | null =>
    able === false ? t('ability.unsupported') : busy ? t('turn.busy') : null
  const forkBlocked = blocked(meta?.can.fork)
  const rollbackBlocked = blocked(meta?.can.rollback)
  // 出不出、切不切在回合中间（turn-actions.ts）
  const { fork: showFork, rollback: showRollback, cut } = messageActions(meta, steered, message)
  if (!showFork && !showRollback && sentAt === null) return null

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

  const forkTitle = forkBlocked ?? t('turn.fork')
  const editTitle = rollbackBlocked ?? t('turn.edit')
  return (
    <div className="umsg-acts">
      {sentAt === null ? null : <Stamp className="umsg-time" at={sentAt} />}
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
          className="ibtn act-edit"
          title={editTitle}
          aria-label={editTitle}
          aria-disabled={rollbackBlocked !== null}
          onClick={() => {
            if (rollbackBlocked) say(rollbackBlocked)
            else onEdit()
          }}
        >
          <Pencil />
        </button>
      ) : null}
    </div>
  )
}
