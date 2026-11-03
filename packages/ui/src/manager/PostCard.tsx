import {
  createContext,
  type HTMLAttributes,
  type ReactNode,
  useContext,
  useId,
  useState,
} from 'react'
import type { ManagerView } from '../../../core/src/model-manager.mts'
import { useT } from '../app/appearance.ts'
import { DiscussionSlotContext, useDiscussionPane } from './discussion-pane.ts'
import {
  postCollapsed,
  postSummary,
  postViewKey,
  rememberPostCollapsed,
} from './post-presentation.ts'

/** 分页卡头负责开合，内部帖子保留讨论入口但不再显示第二个卡头。 */
export const InlinePostContext = createContext(false)

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
  const inline = useContext(InlinePostContext)
  const [savedCollapsed, setCollapsed] = useState(() => postCollapsed(key, closed))
  const collapsed = inline ? false : savedCollapsed
  const bodyId = useId()
  // 有看板分屏时，讨论入口放在标题行末尾的插槽里，讨论内容进分屏（PostDiscussion）
  const pane = useDiscussionPane()
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const change = (value: boolean) => {
    rememberPostCollapsed(key, value)
    setCollapsed(value)
  }
  return (
    <article
      {...props}
      data-post-card={id}
      data-post-collapsed={collapsed}
      data-discussion-open={pane?.openId === id || undefined}
      onFocus={(event) => {
        // 编号跳转把焦点交给卡片时，直接显示目标内容。
        if (event.target === event.currentTarget) change(false)
      }}
    >
      <header>
        <button
          type="button"
          className="mg-post-toggle"
          hidden={inline}
          data-act="post-collapse"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          title={t(collapsed ? 'manager.postExpand' : 'manager.postCollapse')}
          onClick={() => change(!collapsed)}
        >
          <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
          {heading}
        </button>
        {pane ? <span className="mg-talk-slot" ref={setSlot} /> : null}
      </header>
      {collapsed ? <p className="mg-post-summary ell">{postSummary(text)}</p> : null}
      <div id={bodyId} className="mg-post-body" hidden={collapsed}>
        {children}
      </div>
      <DiscussionSlotContext.Provider value={slot}>
        {discussion?.(collapsed)}
      </DiscussionSlotContext.Provider>
    </article>
  )
}
