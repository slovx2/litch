// 回合末尾的收尾区：收尾留的问题画成问题卡（答案并在卡里），后面是建议任务卡片。作答在输入框上方的待答区。
import { type ItemView, keys, wrapQuestionId } from '@litch/core'
import { memo, useMemo } from 'react'
import { useT } from '../app/appearance.ts'
import { useKeys } from '../app/services.tsx'
import { AskSheet } from '../transcript/AskCard.tsx'
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
  // 只留了问题、没带建议的收尾只画问题卡；什么都没带的空收尾不画
  const shown = items.filter(
    (item): item is ItemView =>
      item !== undefined &&
      !(item.kind === 'toolCall' && item.wrapUp?.suggestions.length === 0 && !item.wrapUp.ask),
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
        const wrap = item.kind === 'toolCall' ? item.wrapUp : undefined
        return (
          <div key={item.id}>
            {wrap?.ask ? (
              <AskSheet
                deviceId={deviceId}
                sessionId={sessionId}
                toggleId={`wrap:${item.id}`}
                questions={[
                  {
                    id: wrapQuestionId(item.id, item.questionSource),
                    title: wrap.ask,
                    options: (wrap.actions ?? []).map((action) => action.label),
                  },
                ]}
              />
            ) : null}
            {wrap?.suggestions.length === 0 ? null : (
              <TreeCard deviceId={deviceId} sessionId={sessionId} itemId={item.id} />
            )}
          </div>
        )
      })}
    </section>
  )
})
