import { type DeviceView, keys, type ManagerBoardPages } from '@litch/core'
import { useLayoutEffect, useRef } from 'react'
import type { ManagerItemId, ManagerItemView } from '../../../core/src/model-manager.mts'
import { requestOpenSession } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { badgeOf, nameOf } from '../app/device.ts'
import { useKey } from '../app/services.tsx'
import { BoardReferences } from './BoardReferences.tsx'

function Item({ item }: { item: ManagerItemView }) {
  const t = useT()
  const parts = item.why.split(/(D-\d+)/)
  const missing = item.blockedBy.filter((id) => !parts.includes(id))
  return (
    <div className="mg-item" data-manager-item={item.id} tabIndex={-1}>
      <div className="grow">
        <span className="mono dim">{item.id}</span> <b>{item.title}</b>
        {item.why || missing.length ? (
          <p className="mg-item-reason">
            <BoardReferences text={item.why} />
            {missing.length ? (
              <>
                {item.why ? ' · ' : ''}
                {t('manager.waitDecisions')}{' '}
                {missing.map((id, index) => (
                  <span key={id}>
                    {index ? ' · ' : ''}
                    <BoardReferences text={id} />
                  </span>
                ))}
              </>
            ) : null}
          </p>
        ) : null}
        {item.unverified.map((text) => (
          <p key={text} className="dim">
            {text}
          </p>
        ))}
        {item.basis.length ? (
          <p className="mg-basis">
            {t('manager.basis')} {item.basis.map((link) => link.label ?? link.target).join(' · ')}
          </p>
        ) : null}
      </div>
      <small>{t(`manager.${item.owner.kind}`)}</small>
    </div>
  )
}

export function BoardPanels({
  pages,
  deviceId,
  tab,
  onTab,
  target,
  onLocated,
}: {
  pages: ManagerBoardPages
  deviceId: string
  tab: 'overview' | 'items' | 'lines'
  onTab(tab: 'decisions' | 'items' | 'lines'): void
  target: { id: ManagerItemId } | null
  onLocated(): void
}) {
  const t = useT()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const list = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (tab !== 'items' || !target) return
    const item = list.current?.querySelector<HTMLElement>(`[data-manager-item="${target.id}"]`)
    if (!item) return
    // 已完成、暂缓默认折叠；先展开所在分组，再滚动和聚焦。
    const group = item.closest('details')
    if (group) group.open = true
    item.scrollIntoView({ block: 'start' })
    item.focus({ preventScroll: true })
    onLocated()
  }, [tab, target, onLocated])
  if (tab === 'items')
    return (
      <div className="mg-stack" ref={list}>
        {(['blocked', 'running', 'review', 'backlog', 'deferred', 'done'] as const).map(
          (status) => {
            const items = pages.items[status]
            return items.length ? (
              <details key={status} open={status !== 'done' && status !== 'deferred'}>
                <summary>
                  {t(`manager.${status}`)} {items.length}
                </summary>
                {items.map((item) => (
                  <Item key={item.id} item={item} />
                ))}
              </details>
            ) : null
          },
        )}
        {!pages.overview.stats.totalItems ? <p>{t('manager.none')}</p> : null}
      </div>
    )
  if (tab === 'lines')
    return (
      <div className="mg-stack">
        {pages.lines.map((line) => (
          <article className="mg-card" key={line.threadId}>
            <header>
              <span className="pill mute">{t(`manager.${line.status}`)}</span>
              <b className="grow">{line.title}</b>
              <span className="chip" title={nameOf(device, line.harness)}>
                {badgeOf(device, line.harness)}
              </span>
              <button
                type="button"
                className="btn ghost"
                onClick={() => requestOpenSession({ deviceId, sessionId: line.threadId })}
              >
                {t('manager.openSession')}
              </button>
            </header>
            {line.branch ? (
              <p className="dim mono">
                {line.branch}
                {line.merged !== null
                  ? ` · ${t(line.merged ? 'manager.merged' : 'manager.unmerged')}`
                  : ''}
                {line.ahead !== null ? ` · +${line.ahead}` : ''}
              </p>
            ) : null}
            {line.report ? <p>{line.report.text}</p> : null}
            {line.unverified.map((text) => (
              <p className="mg-unverified" key={text}>
                {text}
              </p>
            ))}
          </article>
        ))}
        {!pages.lines.length ? <p>{t('manager.none')}</p> : null}
      </div>
    )
  const { blocked, waitingForYou, situation, stats, activities } = pages.overview
  const yours = waitingForYou.filter((item) => item.status !== 'blocked')
  return (
    <div className="mg-stack">
      <article className="mg-card">
        <header>
          <b className="grow">{t('manager.situation')}</b>
          <small className="dim">{situation ? new Date(situation.at).toLocaleString() : ''}</small>
        </header>
        <p>{situation?.text ?? t('manager.none')}</p>
      </article>
      <div className="mg-stats">
        <button type="button" onClick={() => onTab('decisions')}>
          <b>{stats.pendingDecisions}</b>
          {t('manager.wait')}
        </button>
        <button type="button" onClick={() => onTab('items')}>
          <b>{yours.length}</b>
          {t('manager.yours')}
        </button>
        <button type="button" onClick={() => onTab('lines')}>
          <b>{stats.runningLines}</b>
          {t('manager.running')}
        </button>
        <button type="button" onClick={() => onTab('items')}>
          <b>{stats.doneItems}</b>
          {t('manager.done')}
        </button>
      </div>
      <section data-overview="blocked">
        <h3>{t('manager.blocked')}</h3>
        {blocked.length ? (
          blocked.map((item) => <Item key={item.id} item={item} />)
        ) : (
          <p className="dim">{t('manager.none')}</p>
        )}
      </section>
      <section data-overview="yours">
        <h3>{t('manager.yours')}</h3>
        {yours.length ? (
          yours.map((item) => <Item key={item.id} item={item} />)
        ) : (
          <p className="dim">{t('manager.none')}</p>
        )}
      </section>
      <section>
        <h3>{t('manager.activity')}</h3>
        {activities.map((activity) => (
          <div className="mg-activity" key={activity.id}>
            <time className="dim">{new Date(activity.at).toLocaleTimeString()}</time>
            <span>{activity.text}</span>
          </div>
        ))}
      </section>
    </div>
  )
}
