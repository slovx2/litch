import { type DeviceView, keys, type ManagerBoardPages } from '@litch/core'
import type { ManagerDecisionId, ManagerItemView } from '../../../core/src/model-manager.mts'
import { requestOpenSession } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { badgeOf, nameOf } from '../app/device.ts'
import { useKey } from '../app/services.tsx'

function Item({
  item,
  onDecision,
}: {
  item: ManagerItemView
  onDecision(id: ManagerDecisionId): void
}) {
  const t = useT()
  const parts = item.why.split(/(D-\d+)/)
  const link = (id: ManagerDecisionId, key: string | number) => (
    <button
      type="button"
      key={key}
      className="mg-decision-link"
      data-decision-link={id}
      onClick={() => onDecision(id)}
    >
      {id}
    </button>
  )
  const missing = item.blockedBy.filter((id) => !parts.includes(id))
  return (
    <div className="mg-item" data-manager-item={item.id}>
      <div className="grow">
        <b>{item.title}</b>
        {item.why || missing.length ? (
          <p className="mg-item-reason">
            {parts.map((part, index) => {
              const id = item.blockedBy.find((id) => id === part)
              return id ? link(id, index) : part
            })}
            {missing.length ? (
              <>
                {item.why ? ' · ' : ''}
                {t('manager.waitDecisions')}{' '}
                {missing.map((id, index) => (
                  <span key={id}>
                    {index ? ' · ' : ''}
                    {link(id, id)}
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
  onDecision,
}: {
  pages: ManagerBoardPages
  deviceId: string
  tab: 'overview' | 'items' | 'lines'
  onTab(tab: 'decisions' | 'items' | 'lines'): void
  onDecision(id: ManagerDecisionId): void
}) {
  const t = useT()
  const device = useKey<DeviceView>(keys.device(deviceId))
  if (tab === 'items')
    return (
      <div className="mg-stack">
        {(['blocked', 'running', 'review', 'backlog', 'deferred', 'done'] as const).map(
          (status) => {
            const items = pages.items[status]
            return items.length ? (
              <details key={status} open={status !== 'done' && status !== 'deferred'}>
                <summary>
                  {t(`manager.${status}`)} {items.length}
                </summary>
                {items.map((item) => (
                  <Item key={item.id} item={item} onDecision={onDecision} />
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
          blocked.map((item) => <Item key={item.id} item={item} onDecision={onDecision} />)
        ) : (
          <p className="dim">{t('manager.none')}</p>
        )}
      </section>
      <section data-overview="yours">
        <h3>{t('manager.yours')}</h3>
        {yours.length ? (
          yours.map((item) => <Item key={item.id} item={item} onDecision={onDecision} />)
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
