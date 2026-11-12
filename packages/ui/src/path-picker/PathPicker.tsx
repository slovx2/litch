import {
  type DeviceView,
  keys,
  type PathPickerKind,
  type PathPickerListing,
  pathPickerChild,
  pathPickerDirectory,
  pathPickerStart,
  readPathPicker,
} from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { Icon } from '../app/icons.tsx'
import { useKey, useServices } from '../app/services.tsx'
import './path-picker.css'

/** 和输入框并列使用。选择只改草稿；取消不会把浏览途中经过的目录写回表单。 */
export function PathPicker({
  deviceId,
  value,
  kind,
  bounded = false,
  compact = false,
  local = false,
  disabled = false,
  onPick,
}: {
  deviceId: string
  value: string
  bounded?: boolean
  compact?: boolean
  kind?: PathPickerKind | undefined
  /** “操作这台电脑”的访问范围属于客户端主机，不属于发请求的远程设备。 */
  local?: boolean
  disabled?: boolean
  onPick(path: string): void
}) {
  const t = useT()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const [mode, setMode] = useState<PathPickerKind | null>(null)
  const [error, setError] = useState('')
  const request = useRef(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 换设备必须撤销旧设备的本机对话框结果和远程浏览草稿。
  useEffect(() => {
    request.current++
    setMode(null)
    setError('')
    return () => {
      request.current++
    }
  }, [deviceId])
  const browse = async (selected: PathPickerKind) => {
    setError('')
    const native =
      !bounded && (local || device?.kind === 'local')
        ? selected === 'directory'
          ? window.litchShell?.pickFolder
          : window.litchShell?.pickFile
        : undefined
    if (!native) {
      if (local) setError(t('pathPicker.nativeUnavailable'))
      else setMode(selected)
      return
    }
    const mine = ++request.current
    try {
      const picked = await native({
        title: t(
          bounded
            ? 'files.nav.open'
            : selected === 'directory'
              ? 'pathPicker.directory'
              : 'pathPicker.file',
        ),
        defaultPath: value.trim(),
      })
      if (mine === request.current && picked) onPick(picked)
    } catch (cause) {
      if (mine === request.current) setError(reasonOf(cause, t))
    }
  }
  return (
    <>
      {(kind ? [kind] : (['directory', 'file'] as const)).map((selected) => (
        <button
          key={selected}
          type="button"
          className={compact ? 'ibtn path-picker-trigger' : 'btn path-picker-trigger'}
          data-path-picker={selected}
          disabled={disabled || (!local && device?.connection !== 'online')}
          title={
            !local && device?.connection !== 'online'
              ? t('pathPicker.offline')
              : t(
                  bounded
                    ? 'files.nav.open'
                    : selected === 'directory'
                      ? 'pathPicker.directory'
                      : 'pathPicker.file',
                )
          }
          aria-label={t(
            bounded
              ? 'files.nav.open'
              : selected === 'directory'
                ? 'pathPicker.directory'
                : 'pathPicker.file',
          )}
          onClick={() => void browse(selected)}
        >
          {compact ? (
            <Icon name="folder" small />
          ) : (
            t(
              bounded
                ? 'files.nav.open'
                : selected === 'directory'
                  ? 'pathPicker.directory'
                  : 'pathPicker.file',
            )
          )}
        </button>
      ))}
      {error ? (
        <span className="err" role="alert">
          {error}
        </span>
      ) : null}
      {mode
        ? createPortal(
            <DevicePathDialog
              key={`${deviceId}:${mode}`}
              deviceId={deviceId}
              kind={mode}
              bounded={bounded}
              start={pathPickerStart(value, mode)}
              onPick={(path) => {
                onPick(path)
                setMode(null)
              }}
              onClose={() => setMode(null)}
            />,
            document.body,
          )
        : null}
    </>
  )
}

function DevicePathDialog({
  deviceId,
  kind,
  bounded,
  start,
  onPick,
  onClose,
}: {
  deviceId: string
  kind: PathPickerKind
  bounded: boolean
  start: string | null
  onPick(path: string): void
  onClose(): void
}) {
  const { channel } = useServices()
  const t = useT()
  const dialog = useRef<HTMLDialogElement>(null)
  const [target, setTarget] = useState({ path: start })
  const [input, setInput] = useState(start ?? '~')
  const [listing, setListing] = useState<PathPickerListing | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal()
  }, [])
  useEffect(() => {
    const abort = new AbortController()
    setBusy(true)
    setError('')
    setListing(null)
    readPathPicker(channel, deviceId, kind, target.path, abort.signal, bounded)
      .then(
        (next) => {
          if (abort.signal.aborted) return
          setListing(next)
          setInput(next.path)
        },
        (cause) => {
          if (!abort.signal.aborted) setError(reasonOf(cause, t))
        },
      )
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false)
      })
    return () => abort.abort()
  }, [channel, deviceId, kind, target, t, bounded])
  const title = t(kind === 'directory' ? 'pathPicker.directory' : 'pathPicker.file')
  return (
    <dialog
      ref={dialog}
      className="modal path-picker-dialog"
      aria-label={title}
      onClose={onClose}
      onCancel={(event) => {
        event.stopPropagation()
        onClose()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation()
      }}
    >
      <div className="modal-head">{title}</div>
      <div className="modal-body">
        <form
          className="path-picker-location"
          onSubmit={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setTarget({ path: input.trim() || null })
          }}
        >
          <input
            className="req-input mono"
            value={input}
            aria-label={t('pathPicker.path')}
            autoFocus
            onChange={(event) => setInput(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button className="btn" type="submit">
            {t('pathPicker.go')}
          </button>
        </form>
        <div className="path-picker-location">
          <button
            type="button"
            className="btn"
            disabled={busy || !listing?.parent}
            onClick={() => setTarget({ path: listing?.parent ?? null })}
          >
            {t('workspace.browse.up')}
          </button>
          <button type="button" className="btn" onClick={() => setTarget({ path: null })}>
            {t('workspace.browse.home')}
          </button>
        </div>
        {busy ? (
          <p role="status">{t('workspace.browse.loading')}</p>
        ) : error ? (
          <p className="err" role="alert">
            {error}
          </p>
        ) : (
          <ul className="path-picker-entries">
            {listing?.entries.map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  className="ws-root"
                  data-path-kind={entry.kind}
                  onClick={() => {
                    if (!listing) return
                    const path = pathPickerChild(listing.path, entry.name)
                    if (pathPickerDirectory(entry)) setTarget({ path })
                    else onPick(path)
                  }}
                >
                  <span className="mono">
                    {entry.name}
                    {pathPickerDirectory(entry) ? '/' : ''}
                    {entry.kind === 'link' ? ` · ${t('pathPicker.link')}` : ''}
                    {entry.executable ? ` · ${t('pathPicker.executable')}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {!busy && !error && listing?.entries.length === 0 ? (
          <p className="form-note">{t('pathPicker.empty')}</p>
        ) : null}
        {listing?.truncated ? <p className="form-note">{t('pathPicker.truncated')}</p> : null}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn" onClick={onClose}>
          {t('workspace.cancel')}
        </button>
        {kind === 'directory' ? (
          <button
            type="button"
            className="btn primary"
            disabled={busy || !listing}
            onClick={() => listing && onPick(listing.path)}
          >
            {t('pathPicker.selectDirectory')}
          </button>
        ) : null}
      </div>
    </dialog>
  )
}
