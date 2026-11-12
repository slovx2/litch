import type { FileLinkResolution, FileLinkTarget } from '@litch/core'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../app/appearance.ts'
import { runFileAction } from './actions.ts'
import { FileLinkDetails } from './FileLinkDetails.tsx'

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
  const failure = result.failures[0]
  const target = result.path || failure?.path || result.href
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return createPortal(
    <dialog
      ref={dialog}
      className="modal ws-dialog file-link-dialog"
      onClose={onClose}
      aria-label={t(result.status === 'choose' ? 'files.link.choose' : 'files.link.failed')}
    >
      <div className="modal-head">
        {t(result.status === 'choose' ? 'files.link.choose' : 'files.link.failed')}
      </div>
      <div className="modal-body">
        {result.status !== 'choose' ? (
          <p>
            {t(`files.link.error.${failure?.reason ?? 'missing'}`)}
            <br />
            {target}
          </p>
        ) : null}
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
        <FileLinkDetails result={result} copy={false} />
      </div>
      <div className="modal-foot">
        <button
          type="button"
          className="btn"
          onClick={() => runFileAction('copyFull', { path: target, relative: '' })}
        >
          {t('files.action.copyFull')}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          {t('workspace.cancel')}
        </button>
      </div>
    </dialog>,
    document.body,
  )
}
