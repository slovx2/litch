import type { SessionMentionView } from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { MentionedText } from './SessionMentions.tsx'

/** 和正文一起挂载：编辑、答题等分支结束后，必须观察新节点。 */
export function UserText({
  deviceId,
  text,
  sessions,
  open,
  onToggle,
}: {
  deviceId: string
  text: string
  sessions: readonly SessionMentionView[] | undefined
  open: boolean
  onToggle(): void
}) {
  const t = useT()
  const body = useRef<HTMLDivElement | null>(null)
  const content = useRef<HTMLDivElement | null>(null)
  const [long, setLong] = useState(false)
  useEffect(() => {
    const element = body.current
    const inner = content.current
    if (!element || !inner || open) return
    const observer = new ResizeObserver(() => {
      setLong(element.scrollHeight > element.clientHeight + 1)
    })
    // 外框被限高后尺寸可能不变，观察内层的完整高度才能发现正文、字体和提及变化。
    // 首次回调异步测量，不在历史消息逐条挂载时强制同步排版。
    observer.observe(inner)
    return () => observer.disconnect()
  }, [open])

  return (
    <>
      <div className={open ? 'umsg-text' : 'umsg-text clamp'} ref={body}>
        <div ref={content}>
          <MentionedText deviceId={deviceId} text={text} sessions={sessions} />
        </div>
      </div>
      {/* 展开状态跨会话切换保留；重挂载后尚无测量结果也必须能收起。 */}
      {long || open ? (
        <button type="button" className="mini" aria-expanded={open} onClick={onToggle}>
          {t(open ? 'message.collapse' : 'message.expand')}
        </button>
      ) : null}
    </>
  )
}
