import { type ReactNode, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { postCollapsed, postSummary, rememberPostCollapsed } from './post-presentation.ts'

export function DiscussionHistory({
  viewKey,
  text,
  defaultOpen = false,
  children,
}: {
  viewKey: string
  text: string
  /** 看板分屏里默认展开（专门用来读讨论）；卡片内嵌时超过 1200 字默认收起 */
  defaultOpen?: boolean
  children: ReactNode
}) {
  const t = useT()
  const [collapsed, setCollapsed] = useState(() =>
    postCollapsed(viewKey, !defaultOpen && text.length > 1200),
  )
  return (
    <details className="mg-discussion-history" open={!collapsed}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 原生 summary 支持键盘触发 click；同步记忆替代异步 toggle。 */}
      <summary
        aria-label={t('manager.discussion')}
        onClick={(event) => {
          // 在卸载前同步记住选择；原生 toggle 事件是异步的，快速收起帖子会先卸载讨论。
          event.preventDefault()
          rememberPostCollapsed(viewKey, !collapsed)
          setCollapsed(!collapsed)
        }}
      >
        {t('manager.discussion')}
        {collapsed ? <span className="ell dim"> · {postSummary(text)}</span> : null}
      </summary>
      {children}
    </details>
  )
}
