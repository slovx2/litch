import { type DeviceView, keys, type SessionSummary, type WorkspaceView } from '@litch/core'
import { useEffect, useState } from 'react'
import type { Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { useNow } from '../app/clock.ts'
import { badgeOf, chipTitle, downHarness, wireStyle } from '../app/device.ts'
import { reasonOf } from '../app/errors.ts'
import { ago } from '../app/format.ts'
import { Close } from '../app/icons.tsx'
import { useKey, useServices } from '../app/services.tsx'

/** 一台设备上已归档的对话。页面打开时向设备要一遍；之后的增减由核心跟着改 */
function DeviceArchive({
  deviceId,
  onOpen,
}: {
  deviceId: string
  onOpen(selection: Selection): void
}) {
  const { channel } = useServices()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId)) ?? []
  const list = useKey<SessionSummary[] | null>(keys.archived(deviceId)) ?? null
  const now = useNow()
  /** 没取到时的那个错误。怎么说到显示的时候再定：换了语言跟着换 */
  const [failure, setFailure] = useState<{ error: unknown } | null>(null)
  /** 正在恢复或删除的那一行，和等着确认删除的那一行 */
  const [busy, setBusy] = useState<string | null>(null)
  const [asking, setAsking] = useState<string | null>(null)
  const [rowFailure, setRowFailure] = useState<{ id: string; text: string } | null>(null)
  const t = useT()
  const online = device?.connection === 'online'

  useEffect(() => {
    if (!online) return
    setFailure(null)
    channel.command('device.loadArchived', { deviceId }).catch((error: unknown) => {
      setFailure({ error })
    })
  }, [channel, deviceId, online])

  if (!device) return null
  const act = (sessionId: string, command: 'session.unarchive' | 'session.delete') => {
    setBusy(sessionId)
    setAsking(null)
    setRowFailure(null)
    channel
      .command(command, { deviceId, sessionId })
      .catch((error: unknown) => {
        setRowFailure({ id: sessionId, text: t('session.failed', { reason: reasonOf(error, t) }) })
      })
      .finally(() => setBusy(null))
  }

  let note: string | null = null
  if (failure !== null) note = t('archived.failed', { reason: reasonOf(failure.error, t) })
  else if (!online && list === null) note = t('archived.offline')
  else if (list === null) note = t('archived.loading')
  else if (list.length === 0) note = t('archived.empty')

  return (
    <section className="arch-dev" style={wireStyle(device.wire)}>
      <h2 className="arch-dev-head">
        <i className={online ? 'wire-sq' : 'wire-sq off'} />
        <span>{t.text(device.name)}</span>
        <span className="mono">{device.host}</span>
      </h2>
      {note ? <div className={failure !== null ? 'arch-note err' : 'arch-note'}>{note}</div> : null}
      {list && list.length > 0 ? (
        <ul className="arch-list">
          {list.map((summary) => (
            <li key={summary.id} className="arch-item">
              <div className="arch-line">
                {/* 点标题就是打开看。设备没连着的时候取不到内容，只是一行字 */}
                {online ? (
                  <button
                    type="button"
                    className="arch-title arch-open ell"
                    title={t('archived.open')}
                    onClick={() => onOpen({ deviceId, sessionId: summary.id })}
                  >
                    {t.text(summary.title)}
                  </button>
                ) : (
                  <span className="arch-title ell">{t.text(summary.title)}</span>
                )}
                <span className="arch-where ell">
                  {workspaces.find((entry) => entry.id === summary.workspaceId)?.name ??
                    t('workspace.none')}
                </span>
                <span
                  className={downHarness(device, summary.harness) ? 'chip off' : 'chip'}
                  title={chipTitle(device, summary.harness, t)}
                >
                  {badgeOf(device, summary.harness)}
                </span>
                <span className="arch-time">{ago(summary.updatedAt, now, t)}</span>
                {asking === summary.id ? (
                  <span className="arch-actions">
                    <span className="arch-ask">{t('session.delete.title')}</span>
                    <button type="button" className="btn ghost" onClick={() => setAsking(null)}>
                      {t('permission.confirm.no')}
                    </button>
                    <button
                      type="button"
                      className="btn danger"
                      onClick={() => act(summary.id, 'session.delete')}
                    >
                      {t('session.delete')}
                    </button>
                  </span>
                ) : (
                  <span className="arch-actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={!online || busy === summary.id}
                      onClick={() => act(summary.id, 'session.unarchive')}
                    >
                      {t('archived.restore')}
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={!online || busy === summary.id}
                      onClick={() => setAsking(summary.id)}
                    >
                      {t('session.delete')}
                    </button>
                  </span>
                )}
              </div>
              {asking === summary.id ? (
                <div className="arch-note">{t('session.delete.note')}</div>
              ) : null}
              {rowFailure?.id === summary.id ? (
                <div className="arch-note err">{rowFailure.text}</div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

interface ArchivedPageProps {
  onClose(): void
  /** 只读地打开其中一个看 */
  onOpen(selection: Selection): void
}

/** 已归档对话：归档了的对话不在侧栏里，都在这一页，按设备分开列，可以打开看、恢复或删掉 */
export function ArchivedPage({ onClose, onOpen }: ArchivedPageProps) {
  const deviceIds = useKey<string[]>(keys.devices) ?? []
  const t = useT()

  // Esc 回到对话
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="arch-page">
      <header className="arch-head">
        <div>
          <h1>{t('archived.title')}</h1>
        </div>
        <button
          type="button"
          className="ibtn"
          title={t('archived.close')}
          aria-label={t('archived.close')}
          onClick={onClose}
        >
          <Close />
        </button>
      </header>
      <div className="arch-body">
        {deviceIds.map((deviceId) => (
          <DeviceArchive key={deviceId} deviceId={deviceId} onOpen={onOpen} />
        ))}
      </div>
    </div>
  )
}
