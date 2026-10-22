// 新建一个组，或者给一个组改名。组是设备上的一条记录（协议里叫自定义分区），里面放会话和项目。
import type { SectionView } from '@litch/core'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'

interface SectionDialogProps {
  deviceId: string
  /** 给了就是改这个组的名字，不是新建 */
  section: SectionView | null
  /** 建好了：新组的标识。在关掉之前叫（比如接着把会话放进去） */
  onCreated?(sectionId: string): void
  onClose(): void
}

export function SectionDialog({ deviceId, section, onCreated, onClose }: SectionDialogProps) {
  const { channel } = useServices()
  const t = useT()
  const dialog = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState(section?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const adding = section === null

  // 用模态方式打开：焦点留在里面，Esc 由浏览器处理
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])

  const title = t(adding ? 'section.add.title' : 'section.rename.title')
  const named = name.trim()
  const ready = named.length > 0 && named !== section?.name

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setFailure(null)
    const done = adding
      ? channel
          .command('section.create', { deviceId, name: named })
          .then(({ sectionId }) => onCreated?.(sectionId))
      : channel.command('section.rename', { deviceId, sectionId: section.id, name: named })
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
        // Esc 只关这个对话框，别让外面的 Esc 处理也跟着动
        if (event.key === 'Escape') event.stopPropagation()
      }}
    >
      <form onSubmit={submit}>
        <div className="modal-head">
          <span className="grow">{title}</span>
        </div>
        <div className="modal-body">
          <div className="form-field">
            <label className="form-label" htmlFor="section-name">
              {t('section.name')}
            </label>
            <input
              id="section-name"
              className="req-input"
              value={name}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
          </div>
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
