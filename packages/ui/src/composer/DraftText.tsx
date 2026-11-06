// 还没发出去的一段话（排队的消息）：正文里提到的会话（@[标题]）画成和对话里一样的片，点了打开那个会话
import type { MessageExtra } from '@litch/core'
import { Fragment, type ReactNode } from 'react'
import { requestOpenSession } from '../app/actions.ts'
import { ActionsProvider } from '../transcript/actions.tsx'
import { SessionPill } from '../transcript/SessionMentions.tsx'
import { mentionRanges } from './mention-field.ts'

/** 输入区不在对话区里：点片和在侧栏里点那个会话一样 */
const OPEN = { busy: false, open: requestOpenSession }

export function DraftText({
  deviceId,
  text,
  extras,
}: {
  deviceId: string
  text: string
  extras: readonly MessageExtra[]
}) {
  const ranges = mentionRanges(
    text,
    extras.flatMap((extra) => (extra.kind === 'session' ? [extra] : [])),
  )
  if (ranges.length === 0) return <>{text}</>
  const parts: ReactNode[] = []
  let at = 0
  for (const range of ranges) {
    if (range.start > at)
      parts.push(<Fragment key={`t${at}`}>{text.slice(at, range.start)}</Fragment>)
    parts.push(<SessionPill key={`m${range.start}`} deviceId={deviceId} mention={range} />)
    at = range.end
  }
  if (at < text.length) parts.push(<Fragment key={`t${at}`}>{text.slice(at)}</Fragment>)
  return <ActionsProvider value={OPEN}>{parts}</ActionsProvider>
}
