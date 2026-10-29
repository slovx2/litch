// 默认收成一行的卡片共用的那一行（系统消息、子会话回报、别的会话发来的话、答过的问题）：
// 图标、来源、摘要、右端的箭头，整行能点。展开之后摘要不再显示，全文在下面；箭头跟着 aria-expanded 转（base.css 的 .caret-ic）。
import type { ReactNode } from 'react'
import { Caret } from '../app/icons.tsx'

export function CompactRow({
  icon,
  source,
  summary,
  open,
  onToggle,
  fixed = false,
}: {
  icon?: ReactNode
  source: ReactNode
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
      {icon}
      <span className="compact-source">{source}</span>
      {!open && summary ? <span className="compact-sum">{summary}</span> : null}
      {fixed ? null : <Caret />}
    </button>
  )
}
