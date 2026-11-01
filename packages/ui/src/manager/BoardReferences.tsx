import { createContext, Fragment, useContext } from 'react'
import { type BoardReference, boardReferences } from './references.ts'

export const BoardReferencesContext = createContext<{
  ids: ReadonlySet<BoardReference>
  titles?: ReadonlyMap<string, string>
  open(id: BoardReference): void
} | null>(null)

/** 纯文本编号及 Markdown 正文片段共用同一套跳转规则。 */
export function BoardReferences({ text }: { text: string }) {
  const context = useContext(BoardReferencesContext)
  if (!context) return text
  const parts = boardReferences(text, context.ids)
  return parts.map((part, index) => {
    let punctuation = ''
    const next = parts[index + 1]
    if (part.id && next && !next.id) {
      punctuation = next.text.match(/^[，。、；：！？,.!?;:）)】\]]+/u)?.[0] ?? ''
      if (punctuation) next.text = next.text.slice(punctuation.length)
    }
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: 纯文本切段没有本地状态
      <Fragment key={index}>
        {part.id ? (
          <span className="mg-board-reference">
            <button
              type="button"
              className="mg-decision-link"
              title={context.titles?.get(part.id)}
              data-board-reference={part.id}
              data-decision-link={part.id.startsWith('D-') ? part.id : undefined}
              onClick={() => part.id && context.open(part.id)}
            >
              {part.text}
            </button>
            {punctuation}
          </span>
        ) : (
          part.text
        )}
      </Fragment>
    )
  })
}
