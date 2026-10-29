import { type DeviceView, keys } from '@litch/core'
import { useState } from 'react'
import type { ManagerView } from '../../../core/src/model-manager.mts'
import type { Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { Transcript } from '../transcript/Transcript.tsx'
import { BoardPanels } from './BoardPanels.tsx'
import { Decisions } from './Decisions.tsx'
import { useManagerBoard } from './data.ts'

export function ManagerPage({
  manager,
  onOpen,
}: {
  manager: ManagerView
  onOpen(selection: Selection): void
}) {
  const t = useT()
  const { channel } = useServices()
  const { view, pages, error } = useManagerBoard(manager)
  const device = useKey<DeviceView>(keys.device(manager.deviceId))
  const [tab, setTab] = useState<'overview' | 'decisions' | 'items' | 'lines'>('overview')
  const [narrow, setNarrow] = useState<'chat' | 'board'>('chat')
  const [ending, setEnding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const board = view?.board
  const counts = {
    overview: 0,
    decisions: manager.pendingDecisions,
    items: (pages?.overview.stats.totalItems ?? 0) - (pages?.overview.stats.doneItems ?? 0),
    lines: manager.runningLines,
  }
  const disabled = manager.status === 'ended' || device?.connection !== 'online'
  const end = async () => {
    setBusy(true)
    try {
      await channel.command('managers.end', { deviceId: manager.deviceId, managerId: manager.id })
      setEnding(false)
    } catch (cause) {
      setFailure(reasonOf(cause, t))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className="mg-page"
      data-manager="session"
      data-manager-id={manager.id}
      data-narrow={narrow}
    >
      <header className="mg-title">
        <span className="pill mute">{t('manager.manager')}</span>
        <b className="ell grow">{manager.name}</b>
        {manager.status === 'active' ? (
          <button
            type="button"
            className="btn ghost"
            disabled={disabled}
            title={disabled ? t('manager.offline') : undefined}
            onClick={() => setEnding(true)}
          >
            {t('manager.end')}
          </button>
        ) : (
          <span className="dim">{t('manager.ended')}</span>
        )}
      </header>
      {ending ? (
        <div className="mg-end" role="alert">
          <span className="grow">{t('manager.endNote')}</span>
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() => setEnding(false)}
          >
            {t('manager.cancel')}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void end()}>
            {t('manager.end')}
          </button>
          {failure ? <p className="err">{failure}</p> : null}
        </div>
      ) : null}
      <div className="mg-narrow seg">
        {(['chat', 'board'] as const).map((key) => (
          <button
            type="button"
            key={key}
            aria-pressed={narrow === key}
            onClick={() => setNarrow(key)}
          >
            {t(`manager.${key}`)}
            {key === 'board' && manager.pendingDecisions ? ` ${manager.pendingDecisions}` : ''}
          </button>
        ))}
      </div>
      <div className="mg-chat">
        <Transcript deviceId={manager.deviceId} sessionId={manager.threadId} onOpen={onOpen} />
      </div>
      <section className="mg-board" aria-label={t('manager.board')}>
        <div className="mg-scope">
          <span className="dim">{t('manager.scope')}</span>
          <span className="ell" title={manager.scope}>
            {manager.scope}
          </span>
        </div>
        <div className="side-tabs">
          <div className="side-tablist" role="tablist">
            {(['overview', 'decisions', 'items', 'lines'] as const).map((key) => (
              <button
                type="button"
                role="tab"
                className="side-tab"
                key={key}
                data-board-tab={key}
                aria-selected={key === tab}
                onClick={() => setTab(key)}
              >
                {t(`manager.${key}`)}
                {counts[key] ? (
                  <span className={key === 'decisions' ? 'pill wait' : 'pill mute'}>
                    {counts[key]}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
        {disabled ? (
          <p className="mg-readonly">
            {t(manager.status === 'ended' ? 'manager.readOnly' : 'manager.offline')}
          </p>
        ) : null}
        <div className="mg-body">
          {error ? (
            <p className="err" role="alert">
              {reasonOf(error, t)}
            </p>
          ) : view?.available === false ? (
            <p>{t('manager.unavailable')}</p>
          ) : !board || !pages ? (
            <p>{t('manager.loading')}</p>
          ) : (
            <>
              {/* 答复区保持挂载，切页签不丢提交状态；本地草稿独立持久化。 */}
              {tab !== 'decisions' ? (
                <BoardPanels pages={pages} deviceId={manager.deviceId} tab={tab} onTab={setTab} />
              ) : null}
              <Decisions
                manager={manager}
                decisions={board.decisions}
                groups={pages.decisions}
                disabled={disabled}
                visible={tab === 'decisions'}
              />
            </>
          )}
        </div>
        <footer className="mg-foot">{t('manager.process')}</footer>
      </section>
    </section>
  )
}

export function ManagerOrigin({
  manager,
  onOpen,
}: {
  manager: ManagerView
  onOpen(selection: Selection): void
}) {
  const t = useT()
  return (
    <div className="mg-origin">
      <span className="grow">
        {t('manager.from')} · {manager.name}
      </span>
      <button
        type="button"
        className="btn ghost"
        onClick={() => onOpen({ deviceId: manager.deviceId, sessionId: manager.threadId })}
      >
        {t('manager.back')}
      </button>
    </div>
  )
}
