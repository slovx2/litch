// 收尾（wrap_up）留给用户的问题：和模型边干活边问的题一样画成问题卡（asks/AskCell.tsx 的 AskSheet），
// 还没答时列题目和回复按钮的字（作答在输入框上方），答完收起、点开看回答
import { wrapQuestionId } from '@litch/core'
import { memo } from 'react'
import { AskSheet } from '../asks/AskCell'
import type { Props } from '../cells'

export const WrapAskCell = memo(function WrapAskCell({ row }: Props<'wrapAsk'>) {
  return (
    <AskSheet
      cardId={`wrap:${row.itemId}`}
      testID={`wrap-ask:${row.itemId}`}
      questions={[
        {
          id: wrapQuestionId(row.itemId),
          title: row.ask,
          options: row.actions.map((action) => action.label),
        },
      ]}
    />
  )
})
