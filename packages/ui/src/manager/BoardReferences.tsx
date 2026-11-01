import { createContext, Fragment, useContext } from 'react'
import { type BoardReference, boardReferences } from './references.ts'

export const BoardReferencesContext = createContext<{
  ids: ReadonlySet<BoardReference>
  open(id: BoardReference): void
} | null>(null)

/** 纯文本编号及 Markdown 正文片段共用同一套跳转规则。 */
export function BoardReferences({ text }: { text: string }) {
  const context = useContext(BoardReferencesContext)
  if (!context) return text
  return boardReferences(text, context.ids).map((part, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: 纯文本切段没有本地状态
    <Fragment key={index}>
      {part.id ? (
        <button
          type="button"
          className="mg-decision-link"
          data-board-reference={part.id}
          data-decision-link={part.id.startsWith('D-') ? part.id : undefined}
          onClick={() => part.id && context.open(part.id)}
        >
          {part.text}
        </button>
      ) : (
        part.text
      )}
    </Fragment>
  ))
}
