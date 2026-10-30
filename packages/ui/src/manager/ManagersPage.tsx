import type { DeviceView } from '@litch/core'
import { useState } from 'react'
import type { ManagerView } from '../../../core/src/model-manager.mts'
import type { Selection } from '../app/App.tsx'
import { type ManagersRoute, requestManagers } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { wireStyle } from '../app/device.ts'
import { Close, Plus } from '../app/icons.tsx'
import { ManagerForm } from './ManagerForm.tsx'

export function ManagersPage({
  initial,
  onRoute,
  managers,
  devices,
  available,
  onClose,
  onOpen,
}: {
  initial: ManagersRoute
  onRoute(route: ManagersRoute): void
  managers: ManagerView[]
  devices: DeviceView[]
  available: DeviceView[]
  onClose(): void
  onOpen(selection: Selection): void
}) {
  const t = useT()
  const route = initial
  const setRoute = onRoute
  const [summary, setSummary] = useState<string | null>(null)
  const row = (manager: ManagerView) => (
    <div className="mg-list-row" key={manager.id} data-manager-row={manager.id}>
      <button
        type="button"
        className="mg-list-open"
        onClick={() => onOpen({ deviceId: manager.deviceId, sessionId: manager.threadId })}
      >
        <span className="grow">
          <b>{manager.name || t('manager.manager')}</b>
          <span className="dim">{manager.rules}</span>
          {manager.latestActivity ? (
            <small className="dim">{manager.latestActivity.text}</small>
          ) : null}
        </span>
        {manager.status === 'active' ? (
          <span className="dim">{t('manager.linesCount', { n: manager.runningLines })}</span>
        ) : manager.status === 'ending' ? (
          <span className="dim">{t('manager.ending')}</span>
        ) : null}
        {manager.pendingDecisions ? (
          <span className="pill wait">{t('manager.pending', { n: manager.pendingDecisions })}</span>
        ) : null}
      </button>
      {manager.status === 'ended' ? (
        <button
          type="button"
          className="btn ghost"
          onClick={() => setSummary(summary === manager.id ? null : manager.id)}
        >
          {t('manager.summary')}
        </button>
      ) : null}
      {summary === manager.id ? (
        <p className="dim mg-summary-note">{t('manager.summaryPlaceholder')}</p>
      ) : null}
    </div>
  )
  return (
    <div className="arch-page" data-manager="list">
      <header className="arch-head">
        <div>
          <h1>{t(route.view === 'new' ? 'manager.new' : 'manager.all')}</h1>
        </div>
        {route.view === 'list' ? (
          <button type="button" className="btn" onClick={() => requestManagers({ view: 'new' })}>
            <Plus />
            {t('manager.new')}
          </button>
        ) : null}
        <button
          type="button"
          className="ibtn"
          aria-label={t('manager.close')}
          title={t('manager.close')}
          onClick={onClose}
        >
          <Close />
        </button>
      </header>
      <div className="arch-body">
        {route.view === 'new' ? (
          available.length ? (
            <ManagerForm
              devices={available}
              initial={route}
              onCancel={() => setRoute({ view: 'list' })}
              onCreated={onOpen}
            />
          ) : (
            <div className="mng-wrap">
              <p>{t('manager.noDevice')}</p>
              <button type="button" className="btn" onClick={() => setRoute({ view: 'list' })}>
                {t('manager.cancel')}
              </button>
            </div>
          )
        ) : (
          <div className="mng-wrap mg-list">
            {devices.map((device) => {
              const list = managers.filter(
                (manager) => manager.deviceId === device.id && manager.status !== 'ended',
              )
              return list.length ? (
                <section className="mng-sec" key={device.id}>
                  <h2 style={wireStyle(device.wire)}>
                    <i className="wire-sq" /> {t.text(device.name)}
                  </h2>
                  {list.map(row)}
                </section>
              ) : null
            })}
            {managers.some((manager) => manager.status === 'ended') ? (
              <section className="mng-sec">
                <h2>{t('manager.ended')}</h2>
                {devices.map((device) => {
                  const list = managers.filter(
                    (manager) => manager.deviceId === device.id && manager.status === 'ended',
                  )
                  return list.length ? (
                    <section key={device.id}>
                      <h3 style={wireStyle(device.wire)}>
                        <i className="wire-sq" /> {t.text(device.name)}
                      </h3>
                      {list.map(row)}
                    </section>
                  ) : null
                })}
              </section>
            ) : null}
            {!managers.length ? <p className="mg-empty">{t('manager.empty')}</p> : null}
          </div>
        )}
      </div>
    </div>
  )
}
