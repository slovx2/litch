// 设备进程注入给父会话的那段文字（<litch-session-event>）：子会话的回报、唤醒、没调收尾时的提醒。
// 核心已经把它从用户消息里拆出来了（UserMessageItem.event），这里画成一条系统提示，不画成用户说的话；
// 提醒没有回报，只是一行更轻的字。还排着、没交给模型的回报（SessionSummary.queuedNotes）不进对话区：
// 输入框上方“后台任务”右边一个小按钮（QueuedNotesChip），几条合成一个，点开再看，交出去之后它画在带着它的那条消息上。
// 不写“下一回合交给模型”（同 Claude 桌面端）：用户自己在子会话里说话的那一回合不唤醒父会话，排着的回报可能一直等到用户再说话。
// 浮窗里的“立即处理”让设备进程当场交出去（在跑就插进去，停着就开一个回合），不用用户打一句“收到了，你看看”。
import type { SessionEventView, SessionNoteView, SessionSummary } from '@litch/core'
import { keys } from '@litch/core'
import { useState } from 'react'
import { requestOpenSession } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { Caret, Icon } from '../app/icons.tsx'
import { usePopover } from '../app/popover.ts'
import { useKey, useServices } from '../app/services.tsx'
import type { MessageKey } from '../i18n/index.ts'
import { useActions } from '../transcript/actions.tsx'
import { CompactRow } from '../transcript/CompactRow.tsx'
import { useToggle } from '../transcript/state.ts'

const HEAD_TEXT: Partial<Record<string, MessageKey>> = {
  notes: 'tree.event.notes',
  wake: 'tree.event.wake',
  remind: 'tree.event.remind',
  'manager-answers': 'manager.event.answers',
  'manager-open': 'manager.event.open',
  'manager-end': 'manager.event.end',
  'manager-rules': 'manager.event.rules',
} as const

const NOTE_MARK: Record<SessionNoteView['status'], string> = {
  completed: '',
  failed: 'err',
  interrupted: '',
  needsUser: 'wait',
}

/**
 * 一条回报：子会话的标题（还在侧栏里的可以点开）、怎么停下的、最后一条回答的开头。
 * 对话区外面（输入框上方的按钮）没有对话区的动作，由那边给 open
 */
function Note({
  deviceId,
  note,
  open: given,
}: {
  deviceId: string
  note: SessionNoteView
  open?: (selection: { deviceId: string; sessionId: string }) => void
}) {
  const t = useT()
  const actions = useActions()
  const open = given ?? actions.open
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
  sessionId,
  itemId,
  event,
  anchor,
}: {
  deviceId: string
  sessionId: string
  itemId: string
  event: SessionEventView
  /** 这条消息没有用户自己的话（唤醒的回合）时，滚动定位的标记打在这一条上 */
  anchor?: string | undefined
}) {
  const t = useT()
  const [open, setOpen] = useToggle(`${deviceId}:${sessionId}`, `event:${itemId}`, false)
  return (
    <div className="sev" data-event={event.kind} data-anchor={anchor}>
      <CompactRow
        icon={<Icon name="info" small />}
        source={t(HEAD_TEXT[event.kind] ?? 'tree.event.generic')}
        summary={
          event.summary ??
          event.notes
            .map((note) =>
              [note.title || note.threadId, note.excerpt || note.error].filter(Boolean).join('：'),
            )
            .join(' · ')
        }
        open={open}
        onToggle={() => setOpen(!open)}
        fixed={event.notes.length === 0 && !event.body}
      />
      {open && event.body ? (
        // 空行隔开的几段各占一块，段间和回报列表一样只隔一点，不画出整行空白
        <div className="sev-body">
          {event.body.split(/\n{2,}/).map((part, at) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 正文是一整段字拆开的，段落没有别的标识
            <p key={at}>{part}</p>
          ))}
        </div>
      ) : null}
      {open && event.notes.length > 0 ? (
        <ul className="sev-notes">
          {event.notes.map((note) => (
            <Note key={note.threadId} deviceId={deviceId} note={note} />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * 这个会话还排着、没交给模型的子会话回报：输入框上方“后台任务”右边一个小按钮，进队列就出现，交出去就没了，没有的不画。
 * 几条合成一个（“收到 N 条回报”），一条写子会话的标题；点开往上弹出各条
 */
export function QueuedNotesChip({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const t = useT()
  const { channel } = useServices()
  const summary = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const { open, setOpen, root, trigger, pop, onKeyDown } = usePopover()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const notes = summary?.queuedNotes
  if (!notes?.length) return null
  const deliver = () => {
    setBusy(true)
    setFailure(null)
    channel
      .command('session.queuedNotes.deliver', { deviceId, sessionId })
      .then(({ delivered }) => {
        if (delivered === 'none') setFailure(t('tree.queued.notNow'))
        else setOpen(false)
      })
      .catch((error: unknown) => setFailure(whyNot(error, t)))
      .finally(() => setBusy(false))
  }
  const only = notes.length === 1 ? notes[0] : undefined
  const label = only
    ? t('tree.queued.one', { title: only.title || only.threadId })
    : t('tree.queued.many', { count: notes.length })
  return (
    <div className="pick qn-pick" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="qn-chip"
        data-queued={notes.length}
        title={t('tree.queued.hint')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="info" small />
        <span className="lead">{label}</span>
        <Caret />
      </button>
      {open ? (
        <div
          className="pick-pop qn-pop"
          role="dialog"
          aria-label={label}
          ref={pop}
          onKeyDown={onKeyDown}
        >
          <div className="qn-head">
            <p className="qn-hint">{t('tree.queued.hint')}</p>
            <button
              type="button"
              className="btn sm primary qn-deliver"
              disabled={busy}
              onClick={deliver}
            >
              {t('tree.queued.deliver')}
            </button>
          </div>
          {failure ? <p className="qn-failure">{failure}</p> : null}
          <ul className="sev-notes">
            {notes.map((note) => (
              <Note
                key={note.threadId}
                deviceId={deviceId}
                note={note}
                open={(selection) => {
                  setOpen(false)
                  requestOpenSession(selection)
                }}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
