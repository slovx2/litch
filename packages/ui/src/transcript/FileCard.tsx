import type { FileLinkResolution } from '@litch/core'
import {
  attachmentDetail,
  type DeviceView,
  isAbsolutePath,
  keys,
  parentPath,
  type SessionSummary,
  type UserAttachment,
} from '@litch/core'
import { type ReactNode, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { FileLinkDialog } from '../files/FileLinkDialog.tsx'
import { openInFiles } from '../files/state.ts'

export interface AttachmentContext {
  deviceId?: string | undefined
  sessionId?: string | undefined
  cwd?: string | null | undefined
}

/** 输入区和历史共用一张卡；完整路径只放在提示中，预览仍走文件面板。 */
export function FileCard({
  file,
  deviceId,
  sessionId,
  cwd,
  children,
}: AttachmentContext & {
  file: UserAttachment
  children?: ReactNode
}) {
  const t = useT()
  const { channel, replica } = useServices()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resolvedDevice, setResolvedDevice] = useState<string | null>(null)
  const [result, setResult] = useState<FileLinkResolution | null>(null)
  const name = file.label ?? t(`attachment.${file.kind}`)
  const detail =
    file.kind === 'folder'
      ? t('attachment.folder')
      : attachmentDetail({ name, ...(file.size !== undefined ? { size: file.size } : {}) }) ||
        t('attachment.file')
  const open = async () => {
    if (!file.path || busy) return
    let targetId = deviceId
    if (file.client) {
      const ids = replica.store.get<string[]>(keys.devices) ?? []
      targetId = ids.find((id) => replica.store.get<DeviceView>(keys.device(id))?.kind === 'local')
    }
    if (!targetId) {
      setError(t('attachment.desktopRequired'))
      return
    }
    const summary =
      sessionId && deviceId
        ? replica.store.get<SessionSummary>(keys.summary(deviceId, sessionId))
        : null
    const root = isAbsolutePath(file.path)
      ? parentPath(file.path.replace(/[\\/]+$/, ''))
      : (cwd ?? summary?.cwd)
    if (!root) {
      setError(t('attachment.noRoot'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const ref = { path: file.path, alt: null, line: null }
      const found = await channel.command('files.resolve', {
        deviceId: targetId,
        root,
        ref,
        href: file.path,
      })
      const target = found.candidates[0]
      if (found.status === 'ready' && target) {
        openInFiles({ deviceId: targetId, workspaceId: null, ...target, link: found })
      } else {
        setResolvedDevice(targetId)
        setResult(found)
      }
    } catch (reason) {
      setError(reasonOf(reason, t))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="attachment-card-wrap">
      <div className="attachment-card">
        <button
          type="button"
          className="attachment-card-open"
          onClick={() => void open()}
          disabled={!file.path}
          aria-busy={busy}
          title={[file.path, file.client ? t('chip.client') : ''].filter(Boolean).join('\n')}
        >
          <Icon name={file.kind === 'folder' ? 'folder' : 'file'} />
          <span className="attachment-card-info">
            <span className="ell">{name}</span>
            <small className="ell">{detail}</small>
          </span>
        </button>
        {children}
      </div>
      {error ? (
        <span className="attachment-card-error" role="alert">
          {error}
        </span>
      ) : null}
      {result ? (
        <FileLinkDialog
          result={result}
          onClose={() => setResult(null)}
          onPick={(target) => {
            if (resolvedDevice)
              openInFiles({ deviceId: resolvedDevice, workspaceId: null, ...target, link: result })
            setResult(null)
          }}
        />
      ) : null}
    </div>
  )
}
