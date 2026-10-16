// 行内批注在界面上的几块：行底下写批注的那个框、写好的批注、输入区旁边“攒着几条批注”的那个小牌子。
import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Close, Icon } from '../app/icons.tsx'
import type { Translator } from '../i18n/index.ts'
import { clearNotes, type DiffNote, type NoteWords, notesKey, useNotes } from './annotations.ts'

export const noteWords = (t: Translator): NoteWords => ({
  title: (n) => t('diffs.note.sent.title', { n }),
  lines: (from, to) =>
    from === to ? t('diffs.note.line', { from }) : t('diffs.note.lines', { from, to }),
  old: t('diffs.note.sent.old'),
  next: t('diffs.note.sent.next'),
  comment: t('diffs.note.sent.comment'),
})

/** 选中的行底下：写批注的框 */
export function NoteEditor({
  label,
  onSave,
  onCancel,
}: {
  /** “第 12–14 行” */
  label: string
  onSave(text: string): void
  onCancel(): void
}) {
  const t = useT()
  const [text, setText] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => input.current?.focus({ preventScroll: true }), [])
  return (
    <div className="dnote-edit">
      <span className="dim">{label}</span>
      <textarea
        ref={input}
        value={text}
        rows={2}
        placeholder={t('diffs.note.placeholder')}
        aria-label={t('diffs.note.placeholder')}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onCancel()
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && text.trim()) {
            event.preventDefault()
            onSave(text)
          }
        }}
      />
      <span className="dnote-acts">
        <button type="button" className="btn ghost" data-act="note-cancel" onClick={onCancel}>
          {t('diffs.cancel')}
        </button>
        <button
          type="button"
          className="btn primary"
          data-act="note-save"
          disabled={!text.trim()}
          onClick={() => onSave(text)}
        >
          {t('diffs.note.save')}
        </button>
      </span>
    </div>
  )
}

/** 一条写好的批注 */
export function NoteCard({ note, onRemove }: { note: DiffNote; onRemove(): void }) {
  const t = useT()
  return (
    <div className="dnote-card" data-note={note.id}>
      <Icon name="note" small />
      <span className="dnote-text">
        <span className="dnote-at">
          {note.from === note.to
            ? t('diffs.note.line', { from: note.from })
            : t('diffs.note.lines', { from: note.from, to: note.to })}
        </span>
        {note.text}
      </span>
      <button
        type="button"
        className="ibtn"
        data-act="note-remove"
        title={t('diffs.note.remove')}
        aria-label={t('diffs.note.remove')}
        onClick={onRemove}
      >
        <Close />
      </button>
    </div>
  )
}

/** 输入区底栏上的小牌子：这个会话攒着几条批注，下一条消息会带上。一条都没有就不出现 */
export function PendingNotes({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const t = useT()
  const key = notesKey(deviceId, sessionId)
  const notes = useNotes(key)
  const tip = useMemo(
    () => notes.map((note) => `${note.path}:${note.from} ${note.text}`).join('\n'),
    [notes],
  )
  if (notes.length === 0) return null
  return (
    <span className="chip cmp-notes" title={`${t('diffs.note.pending.tip')}\n${tip}`}>
      <Icon name="note" small />
      {t('diffs.note.pending', { n: notes.length })}
      <button
        type="button"
        className="cmp-notes-x"
        title={t('diffs.note.clear')}
        aria-label={t('diffs.note.clear')}
        onClick={() => clearNotes(key)}
      >
        <Close />
      </button>
    </span>
  )
}
