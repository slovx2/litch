import { type HTMLAttributes, type ReactNode, useId, useState } from 'react'
import type { ManagerView } from '../../../core/src/model-manager.mts'
import { useT } from '../app/appearance.ts'
import {
  postCollapsed,
  postSummary,
  postViewKey,
  rememberPostCollapsed,
} from './post-presentation.ts'

export function PostCard({
  manager,
  id,
  text,
  closed = false,
  heading,
  discussion,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'id'> & {
  manager: ManagerView
  id: string
  text: string
  closed?: boolean
  heading: ReactNode
  discussion?(collapsed: boolean): ReactNode
}) {
  const t = useT()
  const key = postViewKey(manager.deviceId, manager.id, id)
  const [collapsed, setCollapsed] = useState(() => postCollapsed(key, closed))
  const bodyId = useId()
  const change = (value: boolean) => {
    rememberPostCollapsed(key, value)
    setCollapsed(value)
  }
  return (
    <article
      {...props}
      data-post-collapsed={collapsed}
      onFocus={(event) => {
        // 编号跳转把焦点交给卡片时，直接显示目标内容。
        if (event.target === event.currentTarget) change(false)
      }}
    >
      <header>
        <button
          type="button"
          className="ic"
          data-act="post-collapse"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={t(collapsed ? 'manager.postExpand' : 'manager.postCollapse')}
          title={t(collapsed ? 'manager.postExpand' : 'manager.postCollapse')}
          onClick={() => change(!collapsed)}
        >
          <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        </button>
        {heading}
      </header>
      {collapsed ? <p className="mg-post-summary ell">{postSummary(text)}</p> : null}
      <div id={bodyId} className="mg-post-body" hidden={collapsed}>
        {children}
      </div>
      {discussion?.(collapsed)}
    </article>
  )
}
