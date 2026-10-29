import type { DeviceView } from '@litch/core'
import { type ReactNode, useState } from 'react'
import type { ManagerView } from '../../../core/src/model-manager.mts'
import type { Selection } from '../app/App.tsx'
import { requestManagers } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { wireStyle } from '../app/device.ts'
import { Caret, Forward } from '../app/icons.tsx'
import { answeredDrafts, useAnswerDrafts } from './drafts.ts'

function ManagerRow({
  manager,
  device,
  selection,
  onSelect,
  children,
}: {
  manager: ManagerView
  device: DeviceView | undefined
  selection: Selection | null
  onSelect(selection: Selection): void
  children: ReactNode
}) {
  const t = useT()
  const [open, setOpen] = useState(true)
  const { drafts } = useAnswerDrafts(manager.deviceId, manager.id)
  const count = answeredDrafts(drafts).length
  const picked =
    selection?.deviceId === manager.deviceId && selection.sessionId === manager.threadId
  return (
    <div
      className="mg-sidebar-manager"
      style={wireStyle(device?.wire)}
      data-manager-id={manager.id}
    >
      <div className="mg-sidebar-row" data-selected={picked}>
        <button
          type="button"
          className="ibtn mg-fold"
          aria-expanded={open}
          aria-label={manager.name}
          onClick={() => setOpen(!open)}
        >
          <Caret />
        </button>
        <button
          type="button"
          className="mg-pick"
          aria-current={picked ? 'page' : undefined}
          onClick={() => onSelect({ deviceId: manager.deviceId, sessionId: manager.threadId })}
        >
          <i className={manager.runningLines ? 'st run' : 'st'} />
          <span className="ell grow">{manager.name || t('manager.manager')}</span>
          <i className="wire-sq" title={device ? t.text(device.name) : manager.deviceId} />
          <small className={manager.pendingDecisions || count ? 'mg-attention' : 'dim'}>
            {manager.status === 'ending'
              ? t('manager.ending')
              : count
                ? t('manager.draftCount', { n: count })
                : manager.pendingDecisions
                  ? t('manager.pending', { n: manager.pendingDecisions })
                  : t(manager.runningLines ? 'manager.running' : 'manager.idle')}
          </small>
        </button>
      </div>
      {open ? <div className="mg-sidebar-children">{children}</div> : null}
    </div>
  )
}

export function ManagerSidebar({
  managers,
  devices,
  selection,
  onSelect,
  tree,
}: {
  managers: ManagerView[]
  devices: DeviceView[]
  selection: Selection | null
  onSelect(selection: Selection): void
  tree(manager: ManagerView): ReactNode
}) {
  const t = useT()
  const [ended, setEnded] = useState(false)
  return (
    <>
      {(['active', 'ended'] as const).map((status) => (
        <section key={status} className="mg-sidebar-group">
          <header>
            <button
              type="button"
              className="head-toggle"
              aria-expanded={status === 'active' || ended}
              onClick={() => {
                if (status === 'ended') setEnded(!ended)
              }}
            >
              {status === 'ended' ? <Caret /> : null}
              <span>{t(`manager.${status}`)}</span>
            </button>
            <button
              type="button"
              className="ibtn"
              aria-label={t('manager.all')}
              title={t('manager.all')}
              onClick={() => requestManagers({ view: 'list' })}
            >
              <Forward />
            </button>
          </header>
          {status === 'active' || ended
            ? managers
                .filter((manager) =>
                  status === 'active' ? manager.status !== 'ended' : manager.status === 'ended',
                )
                .map((manager) => (
                  <ManagerRow
                    key={`${manager.deviceId}:${manager.id}`}
                    manager={manager}
                    device={devices.find((device) => device.id === manager.deviceId)}
                    selection={selection}
                    onSelect={onSelect}
                  >
                    {tree(manager)}
                  </ManagerRow>
                ))
            : null}
        </section>
      ))}
      {!managers.length ? <p className="mg-empty">{t('manager.empty')}</p> : null}
    </>
  )
}
