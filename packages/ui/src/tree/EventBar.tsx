// 设备进程注入给父会话的那段文字（<litch-session-event>）：子会话的回报、唤醒、没调收尾时的提醒。
// 核心已经把它从用户消息里拆出来了（UserMessageItem.event），这里画成一条系统提示，不画成用户说的话；
// 提醒没有回报，只是一行更轻的字。还排着、没交给模型的回报（SessionSummary.queuedNotes）同样画一条，
// 放在对话区末尾（QueuedNotesBar），交出去之后它画在带着它的那条消息上。照 Claude 桌面端，排着的和交出去的
// 画得一样，不另写“下一回合交给模型”：用户自己在子会话里说话的那一回合不唤醒父会话，排着的回报可能一直等到用户再说话。
import type { SessionEventView, SessionNoteView, SessionSummary } from '@litch/core'
import { keys } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { Icon } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import { useActions } from '../transcript/actions.tsx'

const HEAD_TEXT = {
  notes: 'tree.event.notes',
  wake: 'tree.event.wake',
  remind: 'tree.event.remind',
} as const satisfies Record<SessionEventView['kind'], string>

const NOTE_MARK: Record<SessionNoteView['status'], string> = {
  completed: '',
  failed: 'err',
  interrupted: '',
  needsUser: 'wait',
}

/** 一条回报：子会话的标题（还在侧栏里的可以点开）、怎么停下的、最后一条回答的开头 */
function Note({ deviceId, note }: { deviceId: string; note: SessionNoteView }) {
  const t = useT()
  const { open } = useActions()
  const listed = useKey<SessionSummary>(keys.summary(deviceId, note.threadId))
  const mark = NOTE_MARK[note.status]
  return (
    <li className="sev-note" data-child={note.threadId} data-status={note.status}>
      <i className={mark ? `st ${mark}` : 'st'} />
      {listed && open ? (
        <button
          type="button"
          className="sev-title"
          title={t('tree.child.open')}
          onClick={() => open({ deviceId, sessionId: note.threadId })}
        >
          {note.title || t.text(listed.title)}
        </button>
      ) : (
        <span className="sev-title">{note.title || note.threadId}</span>
      )}
      <span className="sev-status">{t(`tree.note.${note.status}`)}</span>
      {note.excerpt ? <span className="sev-text">{note.excerpt}</span> : null}
      {note.error ? <span className="sev-text sev-error">{note.error}</span> : null}
    </li>
  )
}

export function SessionEventBar({
  deviceId,
  event,
  anchor,
  queued = false,
}: {
  deviceId: string
  event: SessionEventView
  /** 这条消息没有用户自己的话（唤醒的回合）时，滚动定位的标记打在这一条上 */
  anchor?: string | undefined
  /** 还排着、没交给模型的回报（对话区末尾那一条） */
  queued?: boolean
}) {
  const t = useT()
  return (
    <div
      className="sev"
      data-event={event.kind}
      data-anchor={anchor}
      data-queued={queued || undefined}
    >
      <div className="sev-head">
        <Icon name="info" small />
        <span>{t(HEAD_TEXT[event.kind])}</span>
      </div>
      {event.notes.length > 0 ? (
        <ul className="sev-notes">
          {event.notes.map((note) => (
            <Note key={note.threadId} deviceId={deviceId} note={note} />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** 这个会话还排着、没交给模型的子会话回报：对话区末尾一条，进队列就出现，交出去就没了。没有的不画 */
export function QueuedNotesBar({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const summary = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const notes = summary?.queuedNotes
  if (!notes?.length) return null
  return <SessionEventBar deviceId={deviceId} event={{ kind: 'notes', notes }} queued />
}
