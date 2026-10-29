// 默认收起的卡片共用的头（系统消息、子会话回报、别的会话发来的话、问题卡）：
// 第一行是图标、来源、标题和右端的箭头；收着的时候下面一行是正文摘要（只占一行），点开看全文。
// 展开之后摘要不再显示，全文在下面；箭头跟着 aria-expanded 转（base.css 的 .caret-ic）。
import type { ReactNode } from 'react'
import { Caret } from '../app/icons.tsx'

export function CompactRow({
  icon,
  source,
  title,
  summary,
  open,
  onToggle,
  fixed = false,
}: {
  icon?: ReactNode
  source: ReactNode
  /** 标题：任务名、问题的题目这类，和来源排在同一行 */
  title?: ReactNode
  /** 正文摘要，收着的时候在第二行，只占一行 */
  summary?: ReactNode
  open: boolean
  onToggle(): void
  /** 一直展开、不能收起（问题还没答完）：不画箭头，点了也没反应 */
  fixed?: boolean
}) {
  return (
    <button
      type="button"
      className="compact-message"
      aria-expanded={open}
      disabled={fixed}
      onClick={onToggle}
    >
      <span className="compact-line">
        {icon}
        <span className="compact-source">{source}</span>
        {title ? <span className="compact-title">{title}</span> : null}
        {fixed ? null : <Caret />}
      </span>
      {!open && summary ? (
        <span className="compact-sum" data-indent={icon ? '' : undefined}>
          {summary}
        </span>
      ) : null}
    </button>
  )
}
