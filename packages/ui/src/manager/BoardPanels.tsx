import { type DeviceView, keys, type ManagerBoardPages } from '@litch/core'
import { useLayoutEffect, useRef } from 'react'
import type { ManagerItemId, ManagerItemView } from '../../../core/src/model-manager.mts'
import { requestOpenSession } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { badgeOf, nameOf } from '../app/device.ts'
import { useKey } from '../app/services.tsx'
import { Activity } from './Activity.tsx'
import { BoardLinks } from './BoardLinks.tsx'
import { BoardMarkdown } from './BoardMarkdown.tsx'
import { BoardReferences } from './BoardReferences.tsx'
import { Relations } from './Relations.tsx'

function Item({ item }: { item: ManagerItemView }) {
  const t = useT()
  return (
    <article className="mg-item" data-manager-item={item.id} tabIndex={-1}>
      <header className="mg-item-heading">
        <span className="mono mg-item-id">{item.id}</span>
        <h3>{item.title}</h3>
        <div className="mg-item-badges">
          <span className={`pill ${item.status === 'blocked' ? 'wait' : 'mute'}`}>
            {t(`manager.status.${item.status}`)}
          </span>
          <span className="mg-item-owner">{t(`manager.${item.owner.kind}`)}</span>
        </div>
      </header>
      <Relations id={item.id} kind="item" reverse />
      {item.why ? (
        <div className="mg-item-reason">
          <BoardMarkdown text={item.why} />
        </div>
      ) : null}
      {item.blockedBy.length || item.unverified.length || item.basis.length || item.links.length ? (
        <div className="mg-item-meta">
          {item.blockedBy.length ? (
            <div className="mg-item-meta-row">
              <span className="mg-meta-label">
                {t('manager.waitDecisions', { n: item.blockedBy.length })}
              </span>
              <div className="mg-item-waits">
                {item.blockedBy.map((id) => (
                  <BoardReferences key={id} text={id} />
                ))}
              </div>
            </div>
          ) : null}
          {item.unverified.length ? (
            <div className="mg-item-unverified">
              <span className="pill wait">{t('manager.unverified')}</span>
              <ul>
                {item.unverified.map((text) => (
                  <li key={text}>
                    <BoardMarkdown text={text} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {item.basis.length ? (
            <div className="mg-item-meta-row">
              <span className="mg-meta-label">{t('manager.basis')}</span>
              <BoardLinks links={item.basis} />
            </div>
          ) : null}
          {item.links.length ? (
            <div className="mg-item-meta-row">
              <span className="mg-meta-label">{t('manager.links')}</span>
              <BoardLinks links={item.links} />
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
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
  const { blocked, situation, stats, activities, requests } = pages.overview
  return (
    <div className="mg-stack">
      <article className="mg-card">
        <header>
          <b className="grow">{t('manager.situation')}</b>
          <small className="dim">{situation ? new Date(situation.at).toLocaleString() : ''}</small>
        </header>
        <BoardMarkdown text={situation?.text ?? t('manager.none')} />
      </article>
      <div className="mg-stats">
        <button type="button" onClick={() => onTab('decisions')}>
          <b>{stats.pendingDecisions}</b>
          {t('manager.wait', { n: stats.pendingDecisions })}
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
      {requests.length ? (
        <section data-overview="requests">
          <h3>{t('manager.requests')}</h3>
          {requests.map((request) => (
            <article className="mg-card" key={request.id}>
              <header>
                <BoardReferences text={request.id} />
                <b>{request.title}</b>
              </header>
              <BoardMarkdown text={request.description} />
            </article>
          ))}
        </section>
      ) : null}
      <section>
        <h3>{t('manager.activity')}</h3>
        {activities.map((activity) => (
          <Activity key={activity.id} activity={activity} deviceId={deviceId} />
        ))}
      </section>
    </div>
  )
}
