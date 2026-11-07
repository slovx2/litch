// 经理看板建议卡展开后的简报：背景、任务两段直接摊开，各自超过几行就先折起，按需展开全文。
// 对话流里的提案卡仍用 ProposalCard.tsx 的 Brief（首句加“展开简报”），两处的“背景”“任务”是同一份内容。
import { type ComponentType, useLayoutEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { CardMarkdown } from '../transcript/CardMarkdown.tsx'

/** 一段 Markdown，长了先折起一截，按需展开全文。经理设定卡也用 */
export function FoldText({
  text,
  Markdown,
}: {
  text: string
  Markdown: ComponentType<{ text: string }>
}) {
  const t = useT()
  const box = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  // 折起时内容比可见高度高才给“展开全文”；宽度变了重新量
  const [overflow, setOverflow] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 正文换了要重量，折起的高度不变时观察器收不到
  useLayoutEffect(() => {
    const element = box.current
    if (!element || open) return
    const measure = () => setOverflow(element.scrollHeight > element.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [open, text])
  return (
    <>
      <div ref={box} className="sg-text" data-md="" data-folded={!open || undefined}>
        <Markdown text={text} />
      </div>
      {open || overflow ? (
        <button
          type="button"
          className="prop-more"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {t(open ? 'proposal.brief.fold' : 'proposal.brief.unfold')}
        </button>
      ) : null}
    </>
  )
}

function FoldSection({
  label,
  part,
  text,
  Markdown,
}: {
  label: string
  part: 'background' | 'task'
  text: string
  Markdown: ComponentType<{ text: string }>
}) {
  return (
    <section className="sg-section" data-part={part}>
      <h4 className="sg-label">{label}</h4>
      <FoldText text={text} Markdown={Markdown} />
    </section>
  )
}

export function BriefSections({
  prompt,
  background = '',
  renderText = CardMarkdown,
}: {
  prompt: string
  background?: string
  renderText?: ComponentType<{ text: string }>
}) {
  const t = useT()
  const context = background.trim()
  return (
    <>
      {context ? (
        <FoldSection
          label={t('proposal.brief.background')}
          part="background"
          text={context}
          Markdown={renderText}
        />
      ) : null}
      {prompt.trim() ? (
        <FoldSection
          label={t('proposal.brief.task')}
          part="task"
          text={prompt}
          Markdown={renderText}
        />
      ) : null}
    </>
  )
}
