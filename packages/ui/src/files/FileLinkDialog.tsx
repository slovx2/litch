import type { FileLinkResolution, FileLinkTarget } from '@litch/core'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../app/appearance.ts'

/** 门户避免对话正文的段落、链接等标签约束影响模态框布局。 */
export function FileLinkDialog({
  result,
  onClose,
  onPick,
}: {
  result: FileLinkResolution
  onClose(): void
  onPick(target: FileLinkTarget): void
}) {
  const t = useT()
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return createPortal(
    <dialog
      ref={dialog}
      className="modal ws-dialog"
      onClose={onClose}
      aria-label={t(result.status === 'choose' ? 'files.link.choose' : 'files.link.failed')}
    >
      <div className="modal-head">
        {t(result.status === 'choose' ? 'files.link.choose' : 'files.link.failed')}
      </div>
      <div className="modal-body">
        {result.candidates.map((candidate) => (
          <button
            key={candidate.path}
            type="button"
            className="btn"
            onClick={() => onPick(candidate)}
          >
            {candidate.path}
          </button>
        ))}
        {result.failures.map((failure) => (
          <p key={failure.path}>
            {t(`files.link.error.${failure.reason}`)}
            <br />
            {failure.path}
          </p>
        ))}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn" onClick={onClose}>
          {t('workspace.cancel')}
        </button>
      </div>
    </dialog>,
    document.body,
  )
}
