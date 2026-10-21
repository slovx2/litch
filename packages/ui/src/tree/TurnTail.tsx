// 回合最下方的收尾区：这一回合的建议任务卡片（收尾 wrap_up 带的、start 提的）和收尾留给用户的问题，
// 固定画在最终回答下面，不会被后面的回答冲上去（核心的 bucketItems 把它们排成最后一块 tail）。
// 依次是：问题和回复按钮，然后按调用先后的卡片。卡片照常带状态，过去的回合里能开始的还能开始。
// 问题在下一条用户消息之后失效，折成一行（用户点的是哪个按钮看得出来时写上）。
import { type DeviceView, type ItemView, keys, type SessionMeta, type TurnView } from '@litch/core'
import { memo, useMemo, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { useKey, useKeys, useServices } from '../app/services.tsx'
import { useSendMode } from '../composer/send-mode.ts'
import { runningSend } from '../composer/send-mode-logic.ts'
import { TreeCard } from './TreeCards.tsx'
import { actionText, askOpen, askReplied, type TailAsk, tailAsk } from './tail.ts'

interface TailProps {
  deviceId: string
  sessionId: string
  turnId: string
  itemIds: string[]
}

/** 点过的按钮（会话、条目 → 按钮上的字）：卡片重建、滚出去再回来也还记得点过 */
const clicked = new Map<string, string>()

export const TurnTail = memo(function TurnTail({
  deviceId,
  sessionId,
  turnId,
  itemIds,
}: TailProps) {
  const t = useT()
  const itemKeys = useMemo(
    () => itemIds.map((itemId) => keys.item(deviceId, sessionId, itemId)),
    [deviceId, sessionId, itemIds],
  )
  const items = useKeys<ItemView>(itemKeys)
  const ask = tailAsk(items)
  return (
    <section className="turn-tail" data-tail={turnId} aria-label={t('wrap.tail')}>
      {ask ? <AskLine deviceId={deviceId} sessionId={sessionId} turnId={turnId} ask={ask} /> : null}
      {itemIds.map((itemId) => {
        const item = items[itemIds.indexOf(itemId)]
        // 只留了问题、没带建议的收尾：问题已经在上面了
        if (item?.kind === 'toolCall' && item.wrapUp?.suggestions.length === 0) return null
        return <TreeCard key={itemId} deviceId={deviceId} sessionId={sessionId} itemId={itemId} />
      })}
    </section>
  )
})

/** 收尾留的问题：还能答时带回复按钮，点了把按钮的话当用户消息发出（回合在跑就排队）；过去了折成一行 */
function AskLine({
  deviceId,
  sessionId,
  turnId,
  ask,
}: {
  deviceId: string
  sessionId: string
  turnId: string
  ask: TailAsk
}) {
  const t = useT()
  const { channel, replica } = useServices()
  const memoKey = `${deviceId}:${sessionId}:${ask.itemId}`
  const [picked, setPicked] = useState(() => clicked.get(memoKey) ?? null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const turnIds = useKey<string[]>(keys.turnIds(deviceId, sessionId))
  const turn = useKey<TurnView>(keys.turn(deviceId, sessionId, turnId))
  const meta = useKey<SessionMeta>(keys.session(deviceId, sessionId))
  const device = useKey<DeviceView>(keys.device(deviceId))
  // 下一个回合开头的那条用户消息：认出用户回的是哪个按钮
  const at = turnIds?.indexOf(turnId) ?? -1
  const nextTurn = useKey<TurnView>(keys.turn(deviceId, sessionId, turnIds?.[at + 1] ?? ''))
  const nextFirst = useKey<ItemView>(keys.item(deviceId, sessionId, nextTurn?.itemIds[0] ?? ''))
  const isLast = at >= 0 && at === (turnIds?.length ?? 0) - 1
  const open =
    turn !== undefined &&
    askOpen(
      turn.itemIds,
      ask.itemId,
      isLast,
      (id) => replica.store.get<ItemView>(keys.item(deviceId, sessionId, id))?.kind,
    )
  const replied =
    picked ?? askReplied(ask.actions, nextFirst?.kind === 'userMessage' ? nextFirst.text : null)
  const usable = open && picked === null && meta?.live === true && device?.connection === 'online'

  // 回复按钮和输入框一样跟着“回合进行中发消息”的设置：立即发送且插得了话就插进去，否则排队
  const sendMode = useSendMode()
  const steer = runningSend(sendMode, meta?.can?.steer !== false) === 'steer'
  const send = (action: { label: string; message?: string }) => {
    if (!usable || busy) return
    setBusy(true)
    setFailure(null)
    channel
      .command('session.send', {
        deviceId,
        sessionId,
        text: actionText(action),
        ...(steer ? { now: true } : {}),
      })
      .then(() => {
        clicked.set(memoKey, action.label)
        setPicked(action.label)
      })
      .catch((error: unknown) => setFailure(whyNot(error, t)))
      .finally(() => setBusy(false))
  }

  if (!open) {
    return (
      <div className="tail-ask" data-state="past" title={ask.ask}>
        <i className="st" />
        <span className="ell grow">{ask.ask}</span>
        {replied ? (
          <span className="tail-ask-replied">{t('wrap.replied', { label: replied })}</span>
        ) : null}
      </div>
    )
  }
  return (
    <div className="tail-ask" data-state={picked === null ? 'open' : 'sent'}>
      <div className="tail-ask-q">
        <i className={picked === null ? 'st wait' : 'st'} />
        <span className="grow">{ask.ask}</span>
      </div>
      {ask.actions.length > 0 ? (
        <div className="tail-ask-acts">
          {ask.actions.map((action, index) => (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: 按钮的先后就是身份（第一个是推荐的）
              key={index}
              type="button"
              className={index === 0 ? 'btn primary' : 'btn'}
              data-act={index}
              data-picked={picked === action.label ? '' : undefined}
              disabled={!usable || busy}
              title={actionText(action)}
              onClick={() => send(action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
      {picked ? <p className="tail-ask-hint">{t('wrap.replied', { label: picked })}</p> : null}
      {failure ? <p className="tail-ask-hint err">{failure}</p> : null}
    </div>
  )
}
