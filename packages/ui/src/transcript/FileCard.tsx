import type { FileLinkResolution } from '@litch/core'
import {
  type AttachmentState,
  attachmentDetail,
  attachmentState,
  type DeviceView,
  isAbsolutePath,
  joinPath,
  keys,
  normalizePath,
  parentPath,
  type SessionSummary,
  type UserAttachment,
} from '@litch/core'
import { type ReactNode, useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { Icon } from '../app/icons.tsx'
import { useKey, useKeys, useServices } from '../app/services.tsx'
import { FileDestination } from '../files/FileDestination.tsx'
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
  pending = false,
}: AttachmentContext & {
  file: UserAttachment
  children?: ReactNode
  pending?: boolean
}) {
  const t = useT()
  const { channel } = useServices()
  const device = useKey<DeviceView>(keys.device(deviceId ?? ''))
  const ids = useKey<string[]>(keys.devices) ?? []
  const devices = useKeys<DeviceView>(file.client ? ids.map((id) => keys.device(id)) : [])
  const targetId = file.client ? devices.find((entry) => entry?.kind === 'local')?.id : deviceId
  const summary = useKey<SessionSummary>(keys.summary(deviceId ?? '', sessionId ?? ''))
  const path = file.path ? normalizePath(file.path) : ''
  const root = path && isAbsolutePath(path) ? (parentPath(path) ?? path) : (cwd ?? summary?.cwd)
  const [state, setState] = useState<AttachmentState>('unknown')
  useEffect(() => {
    let active = true
    setState('unknown')
    if (device?.connection !== 'online') return
    void attachmentState(channel, deviceId, { path: file.path, client: file.client }).then(
      (next) => {
        if (active) setState(next)
      },
    )
    return () => {
      active = false
    }
  }, [channel, deviceId, file.path, file.client, device?.connection])
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
    if (!file.path || busy || state === 'cleaned') return
    const next = await attachmentState(channel, deviceId, file)
    setState(next)
    if (next === 'cleaned') return
    if (!targetId) {
      setError(t('attachment.desktopRequired'))
      return
    }
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
          disabled={pending || !file.path || state === 'cleaned'}
          aria-busy={busy}
          title={
            pending
              ? t('composer.file.pending')
              : [file.path, file.client ? t('chip.client') : ''].filter(Boolean).join('\n')
          }
        >
          <Icon name={file.kind === 'folder' ? 'folder' : 'file'} />
          <span className="attachment-card-info">
            <span className="ell">{name}</span>
            <small className="ell">
              {pending
                ? t('composer.file.pending')
                : state === 'cleaned'
                  ? t('attachment.cleaned')
                  : detail}
            </small>
          </span>
        </button>
        {!pending && targetId && root && file.path && state !== 'cleaned' ? (
          <FileDestination
            subject={{
              deviceId: targetId,
              root,
              path: joinPath(root, file.path),
              relative: file.path,
              dir: file.kind === 'folder',
            }}
          />
        ) : null}
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
