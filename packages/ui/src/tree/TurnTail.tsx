// 收尾建议仍在回合末尾；待答问题在输入框上方，答复在原回合留痕。
import { type AskAnswers, type ItemView, keys, wrapQuestionId } from '@litch/core'
import { memo, useMemo } from 'react'
import { useT } from '../app/appearance.ts'
import { useKey, useKeys } from '../app/services.tsx'
import { TreeCard } from './TreeCards.tsx'
export const TurnTail = memo(function TurnTail({
  deviceId,
  sessionId,
  turnId,
  itemIds,
  fresh = false,
}: {
  deviceId: string
  sessionId: string
  turnId: string
  itemIds: string[]
  fresh?: boolean
}) {
  const t = useT()
  const itemKeys = useMemo(
    () => itemIds.map((id) => keys.item(deviceId, sessionId, id)),
    [deviceId, sessionId, itemIds],
  )
  const items = useKeys<ItemView>(itemKeys)
  const answers = useKey<AskAnswers>(keys.answers(deviceId, sessionId)) ?? {}
  const shown = items.filter(
    (item) =>
      item &&
      !(
        item.kind === 'toolCall' &&
        item.wrapUp?.suggestions.length === 0 &&
        answers[wrapQuestionId(item.id)] === undefined
      ),
  )
  if (shown.length === 0) return null
  return (
    <section
      className="turn-tail"
      data-tail={turnId}
      data-fresh={fresh ? '' : undefined}
      aria-label={t('wrap.tail')}
    >
      {shown.map((item) => {
        if (!item) return null
        const ask = item.kind === 'toolCall' ? item.wrapUp?.ask : undefined
        const answer = answers[wrapQuestionId(item.id)]
        return (
          <div key={item.id}>
            {ask && answer !== undefined ? (
              <div className="tail-ask" data-state="past">
                <span className="ell grow">{ask}</span>
                <span className="tail-ask-replied">{t('wrap.replied', { label: answer })}</span>
              </div>
            ) : null}
            {item.kind === 'toolCall' && item.wrapUp?.suggestions.length === 0 ? null : (
              <TreeCard deviceId={deviceId} sessionId={sessionId} itemId={item.id} />
            )}
          </div>
        )
      })}
    </section>
  )
})
