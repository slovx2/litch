import { type DeviceView, keys, type SessionChildren } from '@litch/core'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { ManagerView } from '../../../core/src/model-manager.mts'
import type { Selection } from '../app/App.tsx'
import { requestManagers } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { wireStyle } from '../app/device.ts'
import { Caret, Forward } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import { containsSession, revealRow } from '../sidebar/reveal.ts'
import { useSidebarReveal } from '../sidebar/reveal-context.ts'
import { answeredDrafts, useAnswerDrafts } from './drafts.ts'

function ManagerRow({
  manager,
  device,
  selection,
  onSelect,
  children,
  reveal,
}: {
  manager: ManagerView
  device: DeviceView | undefined
  selection: Selection | null
  onSelect(selection: Selection): void
  children: ReactNode
  reveal: Selection | null
}) {
  const t = useT()
  const [open, setOpen] = useState(true)
  const row = useRef<HTMLDivElement>(null)
  const { fromTree } = useSidebarReveal()
  useEffect(() => {
    if (!reveal) return
    setOpen(true)
    if (reveal.sessionId !== manager.threadId) return
    const scroll = row.current?.closest<HTMLElement>('.sb-scroll')
    if (row.current && scroll) revealRow(row.current, scroll)
  }, [reveal, manager.threadId])
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
      <div ref={row} className="mg-sidebar-row" data-selected={picked}>
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
          onClick={() => {
            const next = { deviceId: manager.deviceId, sessionId: manager.threadId }
            fromTree(next)
            onSelect(next)
          }}
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
  const { request } = useSidebarReveal()
  const children = useKey<SessionChildren>(keys.children(request?.deviceId ?? ''))
  const target = request
    ? managers.find(
        (manager) =>
          manager.deviceId === request.deviceId &&
          containsSession(children ?? {}, manager.threadId, request.sessionId),
      )
    : undefined
  const targetEnded = target?.status === 'ended'
  useEffect(() => {
    if (request && targetEnded) setEnded(true)
  }, [request, targetEnded])
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
                    reveal={manager === target ? request : null}
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
