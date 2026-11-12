// 新建一个本地分组，或者给它改名。本地分组只存在这台客户端上，可以混装任何设备的会话；只问名字，不问设备。
import { GROUP_NAME_MAX, type LocalGroup, type SessionRef } from '@litch/core'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'

interface LocalGroupDialogProps {
  /** 给了就是改名 */
  group: LocalGroup | null
  /** 新建时一起放进去的会话 */
  members?: SessionRef[]
  onCreated?(groupId: string): void
  onClose(): void
}

export function LocalGroupDialog({ group, members, onCreated, onClose }: LocalGroupDialogProps) {
  const { channel } = useServices()
  const t = useT()
  const dialog = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState(group?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const adding = group === null

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])

  const title = t(adding ? 'local.add.title' : 'local.rename.title')
  const named = name.trim()
  const ready = named.length > 0 && named.length <= GROUP_NAME_MAX && named !== group?.name

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setFailure(null)
    const done = adding
      ? channel
          .command('organizer.apply', {
            action: { type: 'group.create', name: named, ...(members ? { members } : {}) },
          })
          .then(({ groupId }) => {
            if (groupId) onCreated?.(groupId)
          })
      : channel.command('organizer.apply', {
          action: { type: 'group.rename', groupId: group.id, name: named },
        })
    done.then(onClose, (error: unknown) => {
      setBusy(false)
      setFailure(t('session.failed', { reason: reasonOf(error, t) }))
    })
  }

  return (
    <dialog
      ref={dialog}
      className="modal ws-dialog"
      aria-label={title}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation()
      }}
    >
      <form onSubmit={submit}>
        <div className="modal-head">
          <span className="grow">{title}</span>
        </div>
        <div className="modal-body">
          <div className="form-field">
            <label className="form-label" htmlFor="local-group-name">
              {t('section.name')}
            </label>
            <input
              id="local-group-name"
              className="req-input"
              value={name}
              maxLength={GROUP_NAME_MAX}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {adding ? <div className="modal-note">{t('local.note')}</div> : null}
          {failure ? <div className="modal-note err">{failure}</div> : null}
        </div>
        <div className="modal-foot">
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>
            {t('workspace.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={!ready || busy}>
            {t(adding ? 'section.create' : 'workspace.save')}
          </button>
        </div>
      </form>
    </dialog>
  )
}
