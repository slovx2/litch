import { type DeviceView, keys } from '@litch/core'
import { useCallback, useState } from 'react'
import type { ManagerDecisionId, ManagerView } from '../../../core/src/model-manager.mts'
import type { Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { Transcript } from '../transcript/Transcript.tsx'
import { BoardPanels } from './BoardPanels.tsx'
import { Decisions } from './Decisions.tsx'
import { useManagerBoard } from './data.ts'
import { ManagerForm } from './ManagerForm.tsx'

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
  const [decisionTarget, setDecisionTarget] = useState<{ id: ManagerDecisionId } | null>(null)
  const decisionLocated = useCallback(() => setDecisionTarget(null), [])
  const openDecision = (id: ManagerDecisionId) => {
    setTab('decisions')
    setNarrow('board')
    setDecisionTarget({ id })
  }
  const [ending, setEnding] = useState(false)
  const [settings, setSettings] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const board = view?.board
  const counts = {
    overview: 0,
    decisions: manager.pendingDecisions,
    items: (pages?.overview.stats.totalItems ?? 0) - (pages?.overview.stats.doneItems ?? 0),
    lines: manager.runningLines,
  }
  const readOnly = manager.status !== 'active'
  const readOnlyText = t(manager.status === 'ending' ? 'manager.endingNote' : 'manager.readOnly')
  const disabled = readOnly || device?.connection !== 'online'
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
  if (settings && !readOnly) {
    return (
      <section className="arch-page" data-manager="settings">
        <header className="arch-head">
          <h1>{t('manager.settings')}</h1>
          <button type="button" className="btn ghost" onClick={() => setSettings(false)}>
            {t('manager.back')}
          </button>
        </header>
        <div className="arch-body">
          <ManagerForm
            key={`${manager.deviceId}:${manager.id}`}
            devices={device ? [device] : []}
            initial={{ view: 'new', deviceId: manager.deviceId }}
            manager={manager}
            disabled={disabled}
            onCancel={() => setSettings(false)}
            onCreated={() => setSettings(false)}
          />
        </div>
      </section>
    )
  }
  return (
    <section
      className="mg-page"
      data-manager="session"
      data-manager-id={manager.id}
      data-manager-status={manager.status}
      data-narrow={narrow}
    >
      <header className="mg-title">
        <span className="pill mute">{t('manager.manager')}</span>
        <b className="ell grow">{manager.name}</b>
        {manager.status === 'active' ? (
          <>
            <button
              type="button"
              className="btn ghost"
              data-act="manager-settings"
              disabled={disabled}
              title={disabled ? t('manager.offline') : undefined}
              onClick={() => setSettings(true)}
            >
              {t('manager.settings')}
            </button>
            <button
              type="button"
              className="btn ghost"
              data-act="manager-end"
              disabled={disabled}
              title={disabled ? t('manager.offline') : undefined}
              onClick={() => setEnding(true)}
            >
              {t('manager.end')}
            </button>
          </>
        ) : (
          <span className="dim">{t(`manager.${manager.status}`)}</span>
        )}
      </header>
      {ending && !readOnly ? (
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
        <Transcript
          deviceId={manager.deviceId}
          sessionId={manager.threadId}
          onOpen={onOpen}
          footer={readOnly ? <p className="mg-readonly">{readOnlyText}</p> : undefined}
        />
      </div>
      <section className="mg-board" aria-label={t('manager.board')}>
        {manager.rules ? (
          <div className="mg-scope">
            <span className="dim">{t('manager.prompt')}</span>
            <span className="ell" title={manager.rules}>
              {manager.rules}
            </span>
          </div>
        ) : null}
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
          <p className="mg-readonly">{readOnly ? readOnlyText : t('manager.offline')}</p>
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
                <BoardPanels
                  pages={pages}
                  deviceId={manager.deviceId}
                  tab={tab}
                  onTab={setTab}
                  onDecision={openDecision}
                />
              ) : null}
              <Decisions
                manager={manager}
                decisions={board.decisions}
                groups={pages.decisions}
                disabled={disabled}
                visible={tab === 'decisions'}
                target={decisionTarget}
                onLocated={decisionLocated}
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
