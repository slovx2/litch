import { createContext, Fragment, useContext } from 'react'
import { useHoverCard } from '../app/HoverCard.tsx'
import { type BoardReference, boardReferences } from './references.ts'

export const BoardReferencesContext = createContext<{
  ids: ReadonlySet<BoardReference>
  /** 分页未加载的编号点击后由设备校验归属。 */
  deferred?: boolean
  previews?: ReadonlyMap<string, { title: string; status: string }>
  open(id: BoardReference): void
} | null>(null)

function ReferenceLink({
  id,
  preview,
  open,
}: {
  id: BoardReference
  preview: { title: string; status: string } | undefined
  open(id: BoardReference): void
}) {
  const hover = useHoverCard(() => (
    <div className="mg-reference-card">
      <span className="mono dim">#{id}</span>
      <strong>{preview?.title}</strong>
      {preview?.status ? (
        <span className="pill mute mg-reference-state">{preview.status}</span>
      ) : null}
    </div>
  ))
  return (
    <span {...hover.area}>
      <button
        type="button"
        className="mg-decision-link"
        {...hover.anchor}
        data-board-reference={id}
        data-decision-link={id.startsWith('D-') ? id : undefined}
        onClick={() => open(id)}
      >
        #{id}
      </button>
      {hover.card}
    </span>
  )
}

/** 纯文本编号及 Markdown 正文片段共用同一套跳转规则。 */
export function BoardReferences({ text }: { text: string }) {
  const context = useContext(BoardReferencesContext)
  if (!context) return text
  const parts = boardReferences(text, context.ids, context.deferred)
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
            <ReferenceLink
              id={part.id}
              preview={context.previews?.get(part.id)}
              open={context.open}
            />
            {punctuation}
          </span>
        ) : (
          part.text
        )}
      </Fragment>
    )
  })
}
