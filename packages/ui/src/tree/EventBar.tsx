// 设备进程注入给父会话的那段文字（<litch-session-event>）：子会话的回报、唤醒、没调收尾时的提醒。
// 核心已经把它从用户消息里拆出来了（UserMessageItem.event），这里画成一条系统提示，不画成用户说的话；
// 提醒没有回报，只是一行更轻的字。
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
    </li>
  )
}

export function SessionEventBar({
  deviceId,
  event,
  anchor,
}: {
  deviceId: string
  event: SessionEventView
  /** 这条消息没有用户自己的话（唤醒的回合）时，滚动定位的标记打在这一条上 */
  anchor?: string | undefined
}) {
  const t = useT()
  return (
    <div className="sev" data-event={event.kind} data-anchor={anchor}>
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
